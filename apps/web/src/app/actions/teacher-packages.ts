"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { usesEnglishCopy, currencyForTeacher, majorToMinorUnits } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { writeOverride } from "@/lib/audit";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { addMonthsEndOfDayInZone } from "@/lib/dates";
import { revalidateAfterAction } from "@/lib/revalidate";

// Record a package the teacher already sold off-platform — the heart of
// onboarding a MID-PACKAGE student. She types in how many classes the student
// has LEFT (e.g. "4 of 10 remaining") and we store the committed count as
// classesUsed = total - remaining, so the booking/credit ledger (Model B)
// treats it exactly like a funnel-bought package from that point on. No money
// moves through the platform here (it was paid in cash/transfer before), so
// there's no Payment row and pricePaidMinorUnits is informational only.
//
// Country-agnostic and rail-agnostic: this is bookkeeping, not a charge.
// Scoped by teacherId (tenant isolation) and written to the teacher overrides audit trail.

export type ManualPackageState = { error?: string; ok?: string } | undefined;

const intField = (max: number) => z.coerce.number().int().min(0).max(max);

const manualPackageSchema = z
  .object({
    studentId: z.string().uuid(),
    // Optional: links the package to a catalog template for its label and to
    // default the price / expiry. The teacher can still override every field.
    templateId: z
      .string()
      .uuid()
      .optional()
      .or(z.literal("").transform(() => undefined)),
    classesTotal: intField(1000).pipe(z.number().min(1)),
    classesRemaining: intField(1000),
    classDurationMin: z.coerce.number().int().min(1).max(600).default(50),
    // YYYY-MM-DD in the teacher's local view; resolved to end-of-day in her tz.
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    // What the student already paid, in pesos, for the record. Optional.
    amountPaidPesos: z.coerce
      .number()
      .min(0)
      .max(1_000_000)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine((v) => v.classesRemaining <= v.classesTotal, {
    message: "remaining-gt-total",
    path: ["classesRemaining"],
  });

export async function createManualPackageAction(
  _prev: ManualPackageState,
  formData: FormData,
): Promise<ManualPackageState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const parsed = manualPackageSchema.safeParse({
    studentId: formData.get("studentId"),
    templateId: formData.get("templateId") ?? undefined,
    classesTotal: formData.get("classesTotal"),
    classesRemaining: formData.get("classesRemaining"),
    classDurationMin: formData.get("classDurationMin") ?? undefined,
    expiresOn: formData.get("expiresOn") ?? undefined,
    // Empty string would coerce to 0; treat blank as "not provided" so the
    // template price (if any) can stand in.
    amountPaidPesos: formData.get("amountPaidPesos") || undefined,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.message === "remaining-gt-total") {
      return {
        error: en
          ? "Classes left can't exceed the package total."
          : "Las clases restantes no pueden superar el total del paquete.",
      };
    }
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }

  const teacher = await requireOnboardedTeacher();
  const data = parsed.data;

  // Confirm the student is on this teacher's roster (tenant isolation).
  const link = await prisma.teacherStudent.findUnique({
    where: {
      teacherId_studentId: { teacherId: teacher.id, studentId: data.studentId },
    },
    select: { studentId: true },
  });
  if (!link) {
    return { error: en ? "This student isn't in your list." : "Este alumno no está en tu lista." };
  }

  // Template is optional; if given it must belong to this teacher. We use it
  // for the package label, and to default price / expiry when the teacher left
  // those blank.
  const template = data.templateId
    ? await prisma.packageTemplate.findFirst({
        where: { id: data.templateId, teacherId: teacher.id },
        select: { id: true, priceMinorUnits: true, expirationMonths: true },
      })
    : null;
  const templateId = template?.id ?? null;

  const now = new Date();
  const classesUsed = data.classesTotal - data.classesRemaining;

  // Expiry: an explicit date wins (end-of-day in the teacher's tz, like the
  // extend-expiration override); otherwise fall back to the template's
  // expiration window if one was chosen; otherwise no expiry.
  let expiresAt: Date | null = null;
  if (data.expiresOn) {
    expiresAt = fromZonedTime(`${data.expiresOn}T23:59:59`, teacher.timezone);
    if (expiresAt <= now) {
      return {
        error: en
          ? "The expiration date must be in the future."
          : "La fecha de vencimiento debe ser una fecha futura.",
      };
    }
  } else if (template?.expirationMonths) {
    expiresAt = addMonthsEndOfDayInZone(now, template.expirationMonths, teacher.timezone);
  }

  const pricePaidMinorUnits =
    data.amountPaidPesos != null
      ? majorToMinorUnits(data.amountPaidPesos, currencyForTeacher(teacher))
      : (template?.priceMinorUnits ?? 0);

  const packageId = await prisma.$transaction(async (tx) => {
    const pkg = await tx.package.create({
      data: {
        teacherId: teacher.id,
        studentId: data.studentId,
        templateId,
        classesTotal: data.classesTotal,
        classesUsed,
        classDurationMin: data.classDurationMin,
        pricePaidMinorUnits,
        currency: currencyForTeacher(teacher),
        purchasedAt: now,
        expiresAt,
        status: "active",
      },
      select: { id: true },
    });
    await writeOverride({
      tx,
      teacherId: teacher.id,
      targetType: "package",
      targetId: pkg.id,
      action: "create_manual_package",
      reason: en
        ? "Off-platform package recorded by the teacher."
        : "Paquete fuera de la plataforma registrado por la profe.",
      before: null,
      after: {
        classesTotal: data.classesTotal,
        classesUsed,
        classDurationMin: data.classDurationMin,
        pricePaidMinorUnits,
        expiresAt: expiresAt?.toISOString() ?? null,
        templateId,
      },
      actor: null,
    });
    return pkg.id;
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "create_manual_package",
      targetType: "package",
      targetId: packageId,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${data.studentId}`);
  return {
    ok: en
      ? `Package added — ${data.classesRemaining} of ${data.classesTotal} classes left.`
      : `Paquete agregado — ${data.classesRemaining} de ${data.classesTotal} clases restantes.`,
  };
}

// Edit an existing package the teacher already recorded. Same "classes LEFT"
// mental model as the add form: the teacher fixes the total, how many are
// left, the class length, the expiry and the recorded price. Because
// `classesUsed` is a committed-booking ledger (Model B) — it's incremented as
// real bookings are made and drawn down on refunds — we never let an edit push
// it below the number of bookings that already count against this package, or
// the credit ledger could be over-drawn. Scoped by teacherId (tenant isolation) and
// written to the teacher overrides audit trail like the create path. Emits no student-facing
// event: this is bookkeeping, not a charge.

const editPackageSchema = z
  .object({
    packageId: z.string().uuid(),
    classesTotal: intField(1000).pipe(z.number().min(1)),
    classesRemaining: intField(1000),
    classDurationMin: z.coerce.number().int().min(1).max(600).default(50),
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    amountPaidPesos: z.coerce
      .number()
      .min(0)
      .max(1_000_000)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine((v) => v.classesRemaining <= v.classesTotal, {
    message: "remaining-gt-total",
    path: ["classesRemaining"],
  });

export async function editManualPackageAction(
  _prev: ManualPackageState,
  formData: FormData,
): Promise<ManualPackageState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const parsed = editPackageSchema.safeParse({
    packageId: formData.get("packageId"),
    classesTotal: formData.get("classesTotal"),
    classesRemaining: formData.get("classesRemaining"),
    classDurationMin: formData.get("classDurationMin") ?? undefined,
    expiresOn: formData.get("expiresOn") ?? undefined,
    amountPaidPesos: formData.get("amountPaidPesos") || undefined,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.message === "remaining-gt-total") {
      return {
        error: en
          ? "Classes left can't exceed the package total."
          : "Las clases restantes no pueden superar el total del paquete.",
      };
    }
    return { error: en ? "Invalid data." : "Datos inválidos." };
  }

  const teacher = await requireOnboardedTeacher();
  const data = parsed.data;

  // Scope the lookup to this teacher (tenant isolation).
  const pkg = await prisma.package.findFirst({
    where: { id: data.packageId, teacherId: teacher.id },
    select: {
      id: true,
      studentId: true,
      classesTotal: true,
      classesUsed: true,
      classDurationMin: true,
      pricePaidMinorUnits: true,
      expiresAt: true,
      status: true,
      templateId: true,
    },
  });
  if (!pkg) {
    return { error: en ? "Package not found." : "Paquete no encontrado." };
  }
  if (pkg.status !== "active" && pkg.status !== "paused") {
    return {
      error: en
        ? "Only an active or paused package can be edited."
        : "Solo se puede editar un paquete activo o en pausa.",
    };
  }

  // Floor for classesUsed: bookings that already count against this package.
  // The committed count can't drop below them or the credit ledger could be
  // over-drawn. classesUsed currently equals this floor plus any off-platform
  // history recorded at creation, so it's always >= committedBookings today.
  const committedBookings = await prisma.booking.count({
    where: { packageId: pkg.id, countsAgainstPackage: true },
  });
  const newClassesUsed = data.classesTotal - data.classesRemaining;
  if (newClassesUsed < committedBookings) {
    return {
      error: en
        ? `This package already has ${committedBookings} booked or taken class${committedBookings === 1 ? "" : "es"}, so it can't show more than ${data.classesTotal - committedBookings} left.`
        : `Este paquete ya tiene ${committedBookings} clase${committedBookings === 1 ? "" : "s"} reservada${committedBookings === 1 ? "" : "s"} o tomada${committedBookings === 1 ? "" : "s"}, así que no puede mostrar más de ${data.classesTotal - committedBookings} restantes.`,
    };
  }

  const now = new Date();

  // Expiry: an explicit date is end-of-day in the teacher's tz. We only enforce
  // "must be in the future" when the date actually changes, so re-saving a
  // package whose expiry is already past (or today) doesn't get blocked. A
  // blank field clears the expiry (no expiration).
  const currentExpiresOn = pkg.expiresAt
    ? formatInTimeZone(pkg.expiresAt, teacher.timezone, "yyyy-MM-dd")
    : undefined;
  let expiresAt: Date | null = null;
  if (data.expiresOn) {
    expiresAt = fromZonedTime(`${data.expiresOn}T23:59:59`, teacher.timezone);
    const changed = data.expiresOn !== currentExpiresOn;
    if (changed && expiresAt <= now) {
      return {
        error: en
          ? "The expiration date must be in the future."
          : "La fecha de vencimiento debe ser una fecha futura.",
      };
    }
  }

  const pricePaidMinorUnits =
    data.amountPaidPesos != null
      ? majorToMinorUnits(data.amountPaidPesos, currencyForTeacher(teacher))
      : pkg.pricePaidMinorUnits;

  const before = {
    classesTotal: pkg.classesTotal,
    classesUsed: pkg.classesUsed,
    classDurationMin: pkg.classDurationMin,
    pricePaidMinorUnits: pkg.pricePaidMinorUnits,
    expiresAt: pkg.expiresAt?.toISOString() ?? null,
  };
  const after = {
    classesTotal: data.classesTotal,
    classesUsed: newClassesUsed,
    classDurationMin: data.classDurationMin,
    pricePaidMinorUnits,
    expiresAt: expiresAt?.toISOString() ?? null,
  };

  await prisma.$transaction(async (tx) => {
    await tx.package.update({
      where: { id: pkg.id },
      data: {
        classesTotal: data.classesTotal,
        classesUsed: newClassesUsed,
        classDurationMin: data.classDurationMin,
        pricePaidMinorUnits,
        expiresAt,
      },
    });
    await writeOverride({
      tx,
      teacherId: teacher.id,
      targetType: "package",
      targetId: pkg.id,
      action: "edit_manual_package",
      reason: en
        ? "Package details corrected by the teacher."
        : "Detalles del paquete corregidos por la profe.",
      before,
      after,
      actor: null,
    });
  });

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "edit_manual_package",
      targetType: "package",
      targetId: pkg.id,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${pkg.studentId}`);
  return {
    ok: en
      ? `Package updated — ${data.classesRemaining} of ${data.classesTotal} classes left.`
      : `Paquete actualizado — ${data.classesRemaining} de ${data.classesTotal} clases restantes.`,
  };
}

// Permanently delete a package the teacher created by accident — a manual entry
// recorded for the wrong student, duplicated, or fat-fingered and never meant to
// exist. This is the counterpart to pause and edit, not a replacement: pause
// freezes a half-used package's balance, edit fixes its numbers, and delete
// removes a truly empty one outright. To keep it safe we only ever delete a
// package with NOTHING real hanging off it — no bookings (any status) and no
// payments. A booked or taken class is scheduling history (and the
// Booking→Package foreign key is Restrict, so the database would refuse the
// delete regardless); a payment is a financial record that must be refunded,
// never destroyed (the Payment→Package foreign key is Cascade, so deleting the
// package would silently take the payment with it). Anything with history is
// corrected through pause / edit / refund instead. Scoped by teacherId (tenant isolation)
// and written to the teacher overrides audit trail — the audit row outlives the package
// because it stores the id as a plain value, not a foreign key. Emits no
// student-facing event: by definition nothing was ever sent for an empty,
// accidental package.

const deletePackageSchema = z.object({ packageId: z.string().uuid() });

export async function deleteManualPackageAction(
  _prev: ManualPackageState,
  formData: FormData,
): Promise<ManualPackageState> {
  const en = usesEnglishCopy(await getPreferredLocale());

  const parsed = deletePackageSchema.safeParse({
    packageId: formData.get("packageId"),
  });
  if (!parsed.success) {
    return { error: en ? "Invalid request." : "Solicitud inválida." };
  }

  const teacher = await requireOnboardedTeacher();

  // Scope the lookup to this teacher (tenant isolation).
  const pkg = await prisma.package.findFirst({
    where: { id: parsed.data.packageId, teacherId: teacher.id },
    select: {
      id: true,
      studentId: true,
      templateId: true,
      classesTotal: true,
      classesUsed: true,
      classDurationMin: true,
      pricePaidMinorUnits: true,
      purchasedAt: true,
      expiresAt: true,
      status: true,
    },
  });
  if (!pkg) {
    return { error: en ? "Package not found." : "Paquete no encontrado." };
  }

  // History guards — a package only qualifies as "created by accident" when
  // nothing real depends on it. Any booking row means scheduling history; any
  // payment row means money on record. Either one means delete is the wrong
  // tool, so refuse with a message that points at the right one.
  const [bookingCount, paymentCount] = await Promise.all([
    prisma.booking.count({ where: { packageId: pkg.id } }),
    prisma.payment.count({ where: { packageId: pkg.id } }),
  ]);
  const hasClassesError = en
    ? "This package has classes booked or taken, so it can't be deleted. Pause it instead, or cancel its classes first."
    : "Este paquete tiene clases reservadas o tomadas, así que no se puede eliminar. Mejor pausa el paquete, o cancela sus clases primero.";
  if (bookingCount > 0) {
    return { error: hasClassesError };
  }
  if (paymentCount > 0) {
    return {
      error: en
        ? "This package has a payment on record, so it can't be deleted. Refund the payment instead."
        : "Este paquete tiene un pago registrado, así que no se puede eliminar. Mejor reembolsa el pago.",
    };
  }

  const before = {
    classesTotal: pkg.classesTotal,
    classesUsed: pkg.classesUsed,
    classDurationMin: pkg.classDurationMin,
    pricePaidMinorUnits: pkg.pricePaidMinorUnits,
    purchasedAt: pkg.purchasedAt.toISOString(),
    expiresAt: pkg.expiresAt?.toISOString() ?? null,
    status: pkg.status,
    templateId: pkg.templateId,
  };

  try {
    await prisma.$transaction(async (tx) => {
      // Audit first, then delete, so the two land together. The override's
      // targetId is the package id as a plain value (no foreign key), so the
      // record survives the row it describes.
      await writeOverride({
        tx,
        teacherId: teacher.id,
        targetType: "package",
        targetId: pkg.id,
        action: "delete_manual_package",
        reason: en
          ? "Accidental package deleted by the teacher."
          : "Paquete creado por error eliminado por la profe.",
        before,
        after: null,
        actor: null,
      });
      await tx.package.delete({ where: { id: pkg.id } });
    });
  } catch (err) {
    // A booking could be inserted between the guard check and the delete; the
    // Booking→Package Restrict foreign key then rejects the delete and the whole
    // transaction (audit row included) rolls back. Surface it as the same
    // friendly "has classes" message rather than letting it 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { error: hasClassesError };
    }
    throw err;
  }

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "delete_manual_package",
      targetType: "package",
      targetId: pkg.id,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${pkg.studentId}`);
  return { ok: en ? "Package deleted." : "Paquete eliminado." };
}
