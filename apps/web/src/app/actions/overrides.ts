"use server";

import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import { usesEnglishCopy, currencyForTeacher, isCaptionLanguage } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { writeOverride } from "@/lib/audit";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { inngest } from "@/lib/inngest/client";
import { enqueueNoShowStudent } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { isSlotConflictError } from "@/lib/booking/slot-conflict";
import { logger } from "@/lib/logger";
import { revalidateAfterAction } from "@/lib/revalidate";

const log = logger({ surface: "overrides" });

// Teacher overrides — every action writes an Override row with
// `reason` + before/after JSON. Visible to the affected student in their
// class history (teacher overrides + plumbed through /my-classes history view).
//
// One-tap actions in this slice:
//   * mark_complete             — booking scheduled → completed (quota-neutral;
//                                 committed at booking. The UI auto-completes,
//                                 so this is kept for back-compat)
//   * mark_no_show              — booking scheduled → no_show (quota-neutral;
//                                 the class was already committed at booking)
//   * restore_class             — canceled_by_student | no_show → scheduled
//   * waive_cancellation        — canceled_by_student → canceled_by_teacher
//   * extend_expiration         — package.expires_at shift
//   * set_custom_price          — teacher_students.custom_price_minor_units
//
// All actions filter by teacher_id (tenant isolation). Auth resolves teacher via
// requireOnboardedTeacher (Supabase JWT); the booking/package/student
// lookup re-verifies ownership before mutation.

export type OverrideState = { error?: string; ok?: string } | undefined;

const reasonField = z.string().trim().min(3, "Da una razón breve.").max(500);
const bookingIdField = z.string().uuid();
const packageIdField = z.string().uuid();
const studentIdField = z.string().uuid();

// ---------- mark_complete ----------

const markCompleteSchema = z.object({
  bookingId: bookingIdField,
  reason: reasonField,
});

export async function markBookingComplete(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = markCompleteSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const booking = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, teacherId: teacher.id },
    select: {
      id: true,
      status: true,
      packageId: true,
      scheduledStart: true,
      scheduledEnd: true,
    },
  });
  if (!booking) return { error: en ? "We couldn't find the class." : "No encontramos la clase." };
  if (booking.status !== "scheduled") {
    return {
      error: en
        ? "Only scheduled classes can be marked complete."
        : "Sólo se pueden marcar como completas las clases agendadas.",
    };
  }

  const now = new Date();
  const completed = await prisma.$transaction(async (tx) => {
    // Guarded flip: the status pre-check above ran on a read taken outside this
    // transaction, so a double-submit (or a second device) can reach here twice.
    // Guard the transition so the loser doesn't write a duplicate Override row.
    const flipped = await tx.booking.updateMany({
      where: { id: booking.id, status: "scheduled" },
      data: { status: "completed", completedAt: now },
    });
    if (flipped.count === 0) return false;
    // Model B: the class was committed at reservation — completing it is
    // quota-neutral (counts_against_package stays true).
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "booking",
        targetId: booking.id,
        action: "mark_complete",
        reason: parsed.data.reason,
        beforeJson: { status: "scheduled" },
        afterJson: { status: "completed", completedAt: now.toISOString() },
      },
    });
    return true;
  });
  if (!completed) {
    return {
      error: en
        ? "That class was already changed by another action. Refresh and try again."
        : "Esa clase ya fue modificada por otra acción. Actualiza e inténtalo de nuevo.",
    };
  }

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "mark_complete",
      targetType: "booking",
      targetId: booking.id,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${booking.id}`);
  return { ok: en ? "Class marked complete." : "Clase marcada como completa." };
}

// ---------- mark_no_show ----------
//
// the 24-hour cancellation rule "Student no-show." Quota-neutral under Model B — the class was
// committed against the package at booking, so a no-show changes no counts;
// it only relabels history and notifies the student. Accepts both a still-
// `scheduled` class (marked during/just after the slot) and an already-
// `completed` one (relabel after auto-complete) — this `completed → no_show`
// path is what lets auto-complete fire at `scheduled_end` with no grace
// window. `restoreClass` accepts `no_show` to undo. Clearing `completedAt`
// keeps no_show rows consistent regardless of which status they came from.

const markNoShowSchema = z.object({
  bookingId: bookingIdField,
  reason: reasonField,
});

export async function markBookingNoShow(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = markNoShowSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const booking = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, teacherId: teacher.id },
    select: {
      id: true,
      status: true,
      packageId: true,
      studentId: true,
      scheduledStart: true,
    },
  });
  if (!booking) return { error: en ? "We couldn't find the class." : "No encontramos la clase." };
  if (booking.status !== "scheduled" && booking.status !== "completed") {
    return {
      error: en
        ? "Only scheduled or completed classes can be marked as no-show."
        : "Sólo se pueden marcar como no asistencia las clases agendadas o completadas.",
    };
  }

  const notificationId = await prisma.$transaction(async (tx) => {
    // Guarded flip: the status pre-check ran on a read outside this transaction,
    // so a double-submit can reach here twice. Guard the transition (accepting
    // either valid source status) so the loser doesn't write a duplicate
    // Override row or enqueue a second no-show notification to the student.
    const flipped = await tx.booking.updateMany({
      where: { id: booking.id, status: { in: ["scheduled", "completed"] } },
      data: { status: "no_show", completedAt: null },
    });
    if (flipped.count === 0) return null;
    // Model B: a no-show stays committed (the class is forfeit) — it was
    // already counted at reservation, so no quota change here.
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "booking",
        targetId: booking.id,
        action: "mark_no_show",
        reason: parsed.data.reason,
        beforeJson: { status: booking.status },
        afterJson: { status: "no_show" },
      },
    });
    return enqueueNoShowStudent(tx, {
      teacherId: teacher.id,
      studentId: booking.studentId,
      bookingId: booking.id,
    });
  });

  if (notificationId === null) {
    return {
      error: en
        ? "That class was already changed by another action. Refresh and try again."
        : "Esa clase ya fue modificada por otra acción. Actualiza e inténtalo de nuevo.",
    };
  }

  try {
    await emitNotificationQueued({ notificationId, teacherId: teacher.id });
  } catch (err) {
    log.warn("mark_no_show emit failed", { error: err });
  }

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "mark_no_show",
      targetType: "booking",
      targetId: booking.id,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${booking.id}`);
  return {
    ok: en
      ? "Class recorded as no-show. The class still counts (no refund)."
      : "Clase registrada como no asistencia. La clase cuenta igual (sin reembolso).",
  };
}

// ---------- restore_class ----------

const restoreSchema = z.object({
  bookingId: bookingIdField,
  reason: reasonField,
});

export async function restoreClass(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = restoreSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const booking = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, teacherId: teacher.id },
    select: {
      id: true,
      status: true,
      studentId: true,
      packageId: true,
      countsAgainstPackage: true,
      scheduledStart: true,
      scheduledEnd: true,
    },
  });
  if (!booking) return { error: en ? "We couldn't find the class." : "No encontramos la clase." };
  // Only deducted-status bookings make sense for restore. Teacher cancels
  // didn't deduct, so "restoring" a teacher_cancel is a different intent
  // (probably "uncancel"); we keep MVP scope to deducted statuses.
  if (booking.status !== "canceled_by_student" && booking.status !== "no_show") {
    return {
      error: en
        ? "Only student-canceled or no-show classes can be restored."
        : "Sólo se pueden restaurar clases canceladas por el alumno o registradas como no asistencia.",
    };
  }

  // Verify the slot is still free — restoring into an occupied slot would
  // collide with another scheduled booking. The unique-index on
  // (teacher_id, scheduledStart) WHERE status='scheduled' would catch the
  // race, but a friendly check now avoids the noisy P2002 path.
  const conflict = await prisma.booking.findFirst({
    where: {
      teacherId: teacher.id,
      status: "scheduled",
      scheduledStart: booking.scheduledStart,
    },
    select: { id: true },
  });
  if (conflict) {
    return {
      error: en
        ? "That slot is already taken by another class. Cancel the other one first, or ask the student to reschedule."
        : "Ese horario ya está ocupado por otra clase. Cancela la otra primero o pide al alumno que reagende.",
    };
  }

  // Model B: re-committing a *released* booking (≥24h cancel / teacher cancel
  // → flag off) re-claims a class slot, so the package must have room. A
  // <24h cancel or no_show is still committed (flag on) — restoring it is
  // quota-neutral.
  const reclaimsSlot = !booking.countsAgainstPackage;
  if (reclaimsSlot) {
    const pkg = await prisma.package.findFirst({
      where: { id: booking.packageId, teacherId: teacher.id },
      select: { classesUsed: true, classesTotal: true },
    });
    if (pkg && pkg.classesUsed >= pkg.classesTotal) {
      return {
        error: en
          ? "This package has no classes left to restore into."
          : "Este paquete ya no tiene clases disponibles para restaurar.",
      };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Race-safe restore. The status check + capacity pre-check above ran on
      // reads outside this transaction, so a double-submit (or a restore racing
      // a fresh booking) could reach here twice. Guard the booking transition,
      // and do the capacity claim as a column-compared conditional increment so
      // classes_used can never exceed classes_total (which would otherwise be a
      // raw CHECK-violation 500 instead of the friendly "no classes left").
      const flipped = await tx.booking.updateMany({
        where: { id: booking.id, status: booking.status },
        data: { status: "scheduled", countsAgainstPackage: true },
      });
      if (flipped.count === 0) {
        throw Object.assign(new Error("restore-conflict"), { restoreKind: "status" });
      }
      if (reclaimsSlot) {
        const claimed = await tx.package.updateMany({
          where: {
            id: booking.packageId,
            classesUsed: { lt: tx.package.fields.classesTotal },
          },
          data: { classesUsed: { increment: 1 } },
        });
        if (claimed.count === 0) {
          throw Object.assign(new Error("restore-capacity"), { restoreKind: "capacity" });
        }
      }
      await tx.override.create({
        data: {
          teacherId: teacher.id,
          targetType: "booking",
          targetId: booking.id,
          action: "restore_class",
          reason: parsed.data.reason,
          beforeJson: { status: booking.status },
          afterJson: { status: "scheduled" },
        },
      });
    });
  } catch (err) {
    if (err && typeof err === "object" && "restoreKind" in err) {
      const kind = (err as { restoreKind: string }).restoreKind;
      if (kind === "capacity") {
        return {
          error: en
            ? "This package has no classes left to restore into."
            : "Este paquete ya no tiene clases disponibles para restaurar.",
        };
      }
      return {
        error: en
          ? "That class was already changed by another action. Refresh and try again."
          : "Esa clase ya fue modificada por otra acción. Actualiza e inténtalo de nuevo.",
      };
    }
    if (isSlotConflictError(err)) {
      return {
        error: en
          ? "That slot is already taken by another class."
          : "Ese horario ya está ocupado por otra clase.",
      };
    }
    throw err;
  }

  // Re-emit booking.created so the reminder + auto-complete sleepers spin
  // back up against the restored row. They'll short-circuit if the timing
  // has already passed.
  try {
    await inngest.send({
      name: "booking.created",
      data: {
        bookingId: booking.id,
        teacherId: teacher.id,
        studentId: booking.studentId,
        packageId: booking.packageId,
        scheduledStart: booking.scheduledStart.toISOString(),
      },
    });
  } catch (err) {
    log.warn("restore-class event emission failed", { error: err });
  }

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "restore_class",
      targetType: "booking",
      targetId: booking.id,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${booking.id}`);
  return { ok: en ? "Class restored." : "Clase restaurada." };
}

// ---------- waive_cancellation ----------

const waiveSchema = z.object({
  bookingId: bookingIdField,
  reason: reasonField,
});

export async function waiveCancellation(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = waiveSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const booking = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, teacherId: teacher.id },
    select: { id: true, status: true, packageId: true, countsAgainstPackage: true },
  });
  if (!booking) return { error: en ? "We couldn't find the class." : "No encontramos la clase." };
  if (booking.status !== "canceled_by_student") {
    return {
      error: en
        ? "Only student cancellations with a deduction applied can be waived."
        : "Sólo se pueden perdonar cancelaciones del alumno con descuento aplicado.",
    };
  }

  // Model B: a still-committed cancel (<24h penalty, flag on) has a class to
  // refund. A ≥24h cancel already released the class at cancel time BUT spent one
  // pooled schedule-change unit (a canceled_by_student booking with the flag off
  // is, by construction, the ≥24h+budget path — the only branch that clears the
  // flag; the exhausted branch never flips the booking). Waiving that cancel
  // forgives the move too, so give the schedule-change unit back.
  const refunds = booking.countsAgainstPackage;
  const waived = await prisma.$transaction(async (tx) => {
    // Guarded flip: the status pre-check ran on a read outside this
    // transaction, so a double-submit passes it twice — the loser here must
    // not decrement classes_used a second time (a double refund for one
    // waived class).
    const flipped = await tx.booking.updateMany({
      where: { id: booking.id, status: "canceled_by_student" },
      data: { status: "canceled_by_teacher", countsAgainstPackage: false },
    });
    if (flipped.count === 0) return false;
    if (refunds) {
      // Floor-guarded — classes_used should never underflow (it's COUNT of
      // committed bookings, and this one is committed), but a raw
      // packages_classes_used_bounds CHECK violation is a 500, not a
      // friendly error. A floor hit means the invariant is already wrong
      // upstream, not a reason to block the waive — skip the impossible
      // decrement and log loudly for follow-up.
      const refunded = await tx.package.updateMany({
        where: { id: booking.packageId, classesUsed: { gt: 0 } },
        data: { classesUsed: { decrement: 1 } },
      });
      if (refunded.count === 0) {
        log.error("classes_used already at floor — skipped refund on waive", undefined, {
          packageId: booking.packageId,
          bookingId: booking.id,
        });
      }
    } else {
      // ≥24h cancel: return the schedule-change unit it spent. Floor-guarded so
      // a stored value already at 0 (invariant broken upstream) skips the
      // decrement rather than raising a raw CHECK violation.
      const restored = await tx.package.updateMany({
        where: { id: booking.packageId, scheduleChangesUsed: { gt: 0 } },
        data: { scheduleChangesUsed: { decrement: 1 } },
      });
      if (restored.count === 0) {
        log.error("schedule_changes_used already at floor — skipped restore on waive", undefined, {
          packageId: booking.packageId,
          bookingId: booking.id,
        });
      }
    }
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "booking",
        targetId: booking.id,
        action: "waive_cancellation",
        reason: parsed.data.reason,
        beforeJson: { status: "canceled_by_student" },
        afterJson: { status: "canceled_by_teacher" },
      },
    });
    return true;
  });

  if (!waived) {
    return {
      error: en
        ? "That class was already changed by another action. Refresh and try again."
        : "Esa clase ya fue modificada por otra acción. Actualiza e inténtalo de nuevo.",
    };
  }

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "waive_cancellation",
      targetType: "booking",
      targetId: booking.id,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${booking.id}`);
  return {
    ok: en
      ? "Cancellation waived. 1 class restored to the package."
      : "Cancelación perdonada. Se restauró 1 clase al paquete.",
  };
}

// ---------- extend_expiration ----------

const extendSchema = z.object({
  packageId: packageIdField,
  // ISO date (YYYY-MM-DD). Resolved to end-of-day in the teacher's IANA
  // tz (server-authoritative) — using UTC end-of-day shifted expirations by ±1 day for
  // tz-distant teachers near midnight.
  newExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (YYYY-MM-DD)"),
  reason: reasonField,
});

export async function extendPackageExpiration(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = extendSchema.safeParse({
    packageId: formData.get("packageId"),
    newExpiresAt: formData.get("newExpiresAt"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const pkg = await prisma.package.findFirst({
    where: { id: parsed.data.packageId, teacherId: teacher.id },
    select: { id: true, expiresAt: true, status: true },
  });
  if (!pkg) return { error: en ? "Package not found." : "Paquete no encontrado." };

  const newExpiresAt = fromZonedTime(`${parsed.data.newExpiresAt}T23:59:59`, teacher.timezone);
  if (newExpiresAt <= new Date()) {
    return {
      error: en
        ? "The new date must be in the future."
        : "La nueva fecha debe ser una fecha futura.",
    };
  }
  if (pkg.expiresAt && newExpiresAt <= pkg.expiresAt) {
    return {
      error: en
        ? "The new date must be after the current one."
        : "La nueva fecha debe ser posterior a la actual.",
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.package.update({
      where: { id: pkg.id },
      data: { expiresAt: newExpiresAt },
    });
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "package",
        targetId: pkg.id,
        action: "extend_expiration",
        reason: parsed.data.reason,
        beforeJson: { expiresAt: pkg.expiresAt?.toISOString() ?? null },
        afterJson: { expiresAt: newExpiresAt.toISOString() },
      },
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "extend_expiration",
      targetType: "package",
      targetId: pkg.id,
      previousValue: pkg.expiresAt?.toISOString() ?? "",
      newValue: newExpiresAt.toISOString(),
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students`);
  return { ok: en ? "Expiration updated." : "Vencimiento actualizado." };
}

// ---------- set_custom_price ----------

const templatePriceSchema = z.object({
  templateId: z.string().uuid(),
  // null clears this package's agreed price; a number sets it. Minor units.
  minorUnits: z
    .number()
    .int()
    .min(0)
    .max(100_000_000 - 1)
    .nullable(),
});

const customPriceSchema = z.object({
  studentId: studentIdField,
  // One entry per package the form rendered. A template absent from the list
  // is left alone, so a form that only knows about sellable packages cannot
  // silently wipe an agreed price attached to an archived one.
  prices: z.array(templatePriceSchema).max(100),
  reason: reasonField,
});

function parsePricesJson(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setStudentCustomPrice(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = customPriceSchema.safeParse({
    studentId: formData.get("studentId"),
    prices: parsePricesJson(formData.get("pricesJson")),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();

  // Per-student custom pricing is a Pro feature. SETTING a price is gated;
  // clearing one is always allowed so a downgraded teacher can still remove a
  // grandfathered price. A submission that only clears rows therefore passes
  // the gate — the same rule the flat column had, applied per row.
  const setsAny = parsed.data.prices.some((p) => p.minorUnits !== null);
  if (setsAny) {
    const gate = await gateProFeature(teacher.id, "custom_price");
    if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };
  }

  const link = await prisma.teacherStudent.findUnique({
    where: {
      teacherId_studentId: {
        teacherId: teacher.id,
        studentId: parsed.data.studentId,
      },
    },
    select: { teacherId: true },
  });
  if (!link) {
    return {
      error: en ? "This student isn't in your list." : "Este alumno no está en tu lista.",
    };
  }

  // Every template named must belong to THIS teacher. The ids arrive from a
  // client-rendered form, and the composite foreign key only constrains the
  // pairing — it would happily accept another teacher's template id, attaching
  // one of her students' agreed prices to a package that isn't hers.
  const templateIds = [...new Set(parsed.data.prices.map((p) => p.templateId))];
  const owned = await prisma.packageTemplate.findMany({
    where: { id: { in: templateIds }, teacherId: teacher.id },
    select: { id: true },
  });
  if (owned.length !== templateIds.length) {
    return { error: en ? "Unknown package." : "Paquete desconocido." };
  }

  const before = await prisma.teacherStudentTemplatePrice.findMany({
    where: { teacherId: teacher.id, studentId: parsed.data.studentId },
    select: { templateId: true, priceMinorUnits: true },
  });
  const beforeMap: Record<string, number> = Object.fromEntries(
    before.map((r) => [r.templateId, r.priceMinorUnits]),
  );
  const afterMap: Record<string, number> = { ...beforeMap };
  for (const p of parsed.data.prices) {
    if (p.minorUnits === null) delete afterMap[p.templateId];
    else afterMap[p.templateId] = p.minorUnits;
  }

  await prisma.$transaction(async (tx) => {
    for (const p of parsed.data.prices) {
      if (p.minorUnits === null) {
        await tx.teacherStudentTemplatePrice.deleteMany({
          where: {
            teacherId: teacher.id,
            studentId: parsed.data.studentId,
            templateId: p.templateId,
          },
        });
        continue;
      }
      await tx.teacherStudentTemplatePrice.upsert({
        where: {
          teacherId_studentId_templateId: {
            teacherId: teacher.id,
            studentId: parsed.data.studentId,
            templateId: p.templateId,
          },
        },
        // Stamp the teacher's own pricing currency, so the agreed price's
        // denomination is recorded rather than inferred later from a currency
        // she may since have changed.
        create: {
          teacherId: teacher.id,
          studentId: parsed.data.studentId,
          templateId: p.templateId,
          priceMinorUnits: p.minorUnits,
          currency: currencyForTeacher(teacher),
        },
        update: { priceMinorUnits: p.minorUnits, currency: currencyForTeacher(teacher) },
      });
    }
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "student",
        targetId: parsed.data.studentId,
        action: "set_custom_price",
        reason: parsed.data.reason,
        // Per-package from 2026-09-01. Audit rows written before that date
        // carry a flat `customPriceMinorUnits` instead — both shapes live in
        // this table on purpose, and neither is rewritten.
        beforeJson: { pricesByTemplate: beforeMap },
        afterJson: { pricesByTemplate: afterMap },
      },
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "set_custom_price",
      targetType: "student",
      targetId: parsed.data.studentId,
      previousValue: String(Object.keys(beforeMap).length),
      newValue: String(Object.keys(afterMap).length),
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${parsed.data.studentId}`);
  const cleared = Object.keys(afterMap).length === 0;
  return {
    ok: en
      ? cleared
        ? "Custom prices removed."
        : "Custom prices updated for future purchases."
      : cleared
        ? "Precios personalizados eliminados."
        : "Precios personalizados actualizados para futuras compras.",
  };
}

// ---------- archive / reactivate student (teacher "dar de baja") ----------
//
// Roster-scoped: sets/clears `teacher_students.archived_at` for the caller's
// own link only (tenant isolation). This is NOT the global `students.disabled_at`
// moderation flag — archiving just parks the student on this teacher's roster
// and silences lifecycle notifications (enforced centrally in the dispatcher).
// Bookings, packages and login are deliberately untouched; stopping a half-used
// package is the orthogonal per-package pause control. Reversible via "reactivate".

const archiveSchema = z.object({
  studentId: studentIdField,
  intent: z.enum(["archive", "reactivate"]),
  // Unlike custom-price, a reason is optional — churn ("por ahora") often has
  // none. We store a default in the audit row when blank.
  reason: z.string().trim().max(500).optional(),
});

export async function toggleStudentArchive(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = archiveSchema.safeParse({
    studentId: formData.get("studentId"),
    intent: formData.get("intent"),
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const link = await prisma.teacherStudent.findUnique({
    where: {
      teacherId_studentId: { teacherId: teacher.id, studentId: parsed.data.studentId },
    },
    select: { archivedAt: true },
  });
  if (!link) {
    return { error: en ? "This student isn't in your list." : "Este alumno no está en tu lista." };
  }

  const archiving = parsed.data.intent === "archive";
  if (archiving && link.archivedAt) {
    return {
      error: en ? "This student is already archived." : "Este alumno ya está dado de baja.",
    };
  }
  if (!archiving && !link.archivedAt) {
    return { error: en ? "This student is already active." : "Este alumno ya está activo." };
  }

  const reason =
    parsed.data.reason && parsed.data.reason.length > 0
      ? parsed.data.reason
      : archiving
        ? en
          ? "Archived from roster"
          : "Dado de baja del listado"
        : en
          ? "Reactivated on roster"
          : "Reactivado en el listado";
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.teacherStudent.update({
      where: {
        teacherId_studentId: { teacherId: teacher.id, studentId: parsed.data.studentId },
      },
      data: archiving
        ? { archivedAt: now, archivedReason: reason }
        : { archivedAt: null, archivedReason: null },
    });
    await writeOverride({
      tx,
      teacherId: teacher.id,
      targetType: "student",
      targetId: parsed.data.studentId,
      action: archiving ? "archive_student" : "reactivate_student",
      reason,
      before: { archivedAt: link.archivedAt?.toISOString() ?? null },
      after: { archivedAt: archiving ? now.toISOString() : null },
      // Teacher-initiated, not a platform admin.
      actor: null,
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: archiving ? "archive_student" : "reactivate_student",
      targetType: "student",
      targetId: parsed.data.studentId,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${parsed.data.studentId}`);
  return {
    ok: archiving
      ? en
        ? "Student archived."
        : "Alumno dado de baja."
      : en
        ? "Student reactivated."
        : "Alumno reactivado.",
  };
}

// Empty string clears the override for that side (falls back to the
// teacher/student's own default language — see class-access.ts). A blank
// language code is otherwise invalid input, so this is the one field where
// "" is a meaningful value rather than "missing".
const languageOverrideField = z
  .string()
  .refine((v) => v === "" || isCaptionLanguage(v), "Idioma desconocido.");

const languageOverrideSchema = z.object({
  bookingId: bookingIdField,
  teacherLanguage: languageOverrideField,
  studentLanguage: languageOverrideField,
  reason: reasonField,
});

// Live-caption per-booking language override (D-27): "sometimes they change
// language" for one class. Unlike bufferMinSnapshot, this is intentionally
// NOT locked at booking-creation time — it's editable any time before/during
// the class (see the schema comment on Booking.teacherLanguageOverride).
export async function updateBookingLanguageOverrideAction(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = languageOverrideSchema.safeParse({
    bookingId: formData.get("bookingId"),
    teacherLanguage: formData.get("teacherLanguage"),
    studentLanguage: formData.get("studentLanguage"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const teacher = await requireOnboardedTeacher();
  const booking = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, teacherId: teacher.id },
    select: { id: true, teacherLanguageOverride: true, studentLanguageOverride: true },
  });
  if (!booking) return { error: en ? "We couldn't find the class." : "No encontramos la clase." };

  const teacherLanguage = parsed.data.teacherLanguage === "" ? null : parsed.data.teacherLanguage;
  const studentLanguage = parsed.data.studentLanguage === "" ? null : parsed.data.studentLanguage;

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id: booking.id },
      data: {
        teacherLanguageOverride: teacherLanguage,
        studentLanguageOverride: studentLanguage,
      },
    });
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "booking",
        targetId: booking.id,
        action: "set_class_language",
        reason: parsed.data.reason,
        beforeJson: {
          teacherLanguageOverride: booking.teacherLanguageOverride,
          studentLanguageOverride: booking.studentLanguageOverride,
        },
        afterJson: {
          teacherLanguageOverride: teacherLanguage,
          studentLanguageOverride: studentLanguage,
        },
      },
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "set_class_language",
      targetType: "booking",
      targetId: booking.id,
      previousValue: `${booking.teacherLanguageOverride ?? ""}/${booking.studentLanguageOverride ?? ""}`,
      newValue: `${teacherLanguage ?? ""}/${studentLanguage ?? ""}`,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${booking.id}`);
  return { ok: en ? "Class language updated." : "Idioma de la clase actualizado." };
}
