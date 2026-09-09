import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Teacher overrides — covers the five one-tap actions other than
// teacher_cancel (which lives in cancel-handler.*.test.ts). Each action
// must:
//   1. Mutate the right row(s) in a transaction.
//   2. Write an Override audit row with the teacher's reason + before/after JSON.
//   3. Emit a `override_applied` PostHog event with the expected `action` prop.
// 4. Filter by teacher_id (tenant isolation) — wrong-tenant ids return "no encontramos…".
//
// Mocked surface mirrors the wa-webhook test pattern: vi.mock the
// production deps with an in-memory store so we can assert the
// transaction shape end-to-end.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "77777777-7777-4777-8777-777777777777";
const PACKAGE_ID = "44444444-4444-4444-8444-444444444444";
const BOOKING_ID = "55555555-5555-4555-8555-555555555555";
const TEACHER_TZ = "America/Mexico_City";

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  status: string;
  countsAgainstPackage: boolean;
  scheduledStart: Date;
  scheduledEnd: Date;
  completedAt: Date | null;
  teacherLanguageOverride: string | null;
  studentLanguageOverride: string | null;
};
type PackageRow = {
  id: string;
  teacherId: string;
  studentId: string;
  classesUsed: number;
  classesTotal: number;
  scheduleChangesUsed: number;
  expiresAt: Date | null;
  status: string;
};
type TeacherStudentRow = {
  teacherId: string;
  studentId: string;
  customPriceMinorUnits: number | null;
  archivedAt: Date | null;
  archivedReason: string | null;
};
type OverrideRow = {
  id: string;
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  beforeJson: unknown;
  afterJson: unknown;
};
type NotificationRow = {
  id: string;
  teacherId: string;
  recipientType: string;
  recipientId: string;
  bookingId?: string | null;
  paymentId?: string | null;
  channel: string;
  templateName: string;
  status: string;
};

type FakeState = {
  bookings: Map<string, BookingRow>;
  packages: Map<string, PackageRow>;
  teacherStudents: TeacherStudentRow[];
  overrides: OverrideRow[];
  notifications: NotificationRow[];
  // Grandfathering, keyed `${studentId}:${templateId}`.
  agreedPrices: Map<string, number>;
};

const state: FakeState = {
  bookings: new Map(),
  packages: new Map(),
  teacherStudents: [],
  overrides: [],
  notifications: [],
  agreedPrices: new Map(),
};

function freshState() {
  state.bookings.clear();
  state.packages.clear();
  state.teacherStudents.length = 0;
  state.overrides.length = 0;
  state.notifications.length = 0;
  state.agreedPrices.clear();

  state.bookings.set(BOOKING_ID, {
    id: BOOKING_ID,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    packageId: PACKAGE_ID,
    status: "scheduled",
    countsAgainstPackage: true,
    scheduledStart: new Date("2026-05-10T16:00:00.000Z"),
    scheduledEnd: new Date("2026-05-10T16:50:00.000Z"),
    completedAt: null,
    teacherLanguageOverride: null,
    studentLanguageOverride: null,
  });
  state.packages.set(PACKAGE_ID, {
    id: PACKAGE_ID,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    classesUsed: 3,
    classesTotal: 10,
    scheduleChangesUsed: 0,
    expiresAt: new Date("2026-08-01T05:59:59.000Z"),
    status: "active",
  });
  state.teacherStudents.push({
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    customPriceMinorUnits: null,
    archivedAt: null,
    archivedReason: null,
  });
}

const trackServerEventMock = vi.fn();
const inngestSendMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({
    id: TEACHER_ID,
    timezone: TEACHER_TZ,
  })),
}));

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: vi.fn(),
}));

vi.mock("@/lib/inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));
// Phase 2a: notification.queued now routes through the enqueue() seam (the
// booking.created reschedule emit above still uses inngest.send until Phase 2b).
const enqueueMock = vi.fn();
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: enqueueMock }));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

// Minimal Prisma surface used by overrides.ts. We accept whatever the
// action passes and look up against `state`. Transactions resolve
// inline — sequential-only is fine for this assertion shape.
vi.mock("@/lib/prisma", () => {
  // Prisma returns fresh JS objects from findFirst/findUnique; the
  // override actions rely on `before.<field>` being a *snapshot* even
  // after the same row is updated inside the same transaction. Clone on
  // every read so mutations to `state` don't leak back into already-read
  // refs.
  function snapshot<T>(row: T | null): T | null {
    return row ? ({ ...(row as object) } as T) : null;
  }
  function bookingFindFirst({ where }: any) {
    for (const b of state.bookings.values()) {
      if (where.id && b.id !== where.id) continue;
      if (where.teacherId && b.teacherId !== where.teacherId) continue;
      if (where.status && b.status !== where.status) continue;
      if (where.scheduledStart && b.scheduledStart.getTime() !== where.scheduledStart.getTime())
        continue;
      return snapshot(b);
    }
    return null;
  }
  function bookingFindUnique({ where }: any) {
    return snapshot(state.bookings.get(where.id) ?? null);
  }
  function bookingUpdate({ where, data }: any) {
    const b = state.bookings.get(where.id);
    if (!b) throw new Error(`no booking ${where.id}`);
    Object.assign(b, data);
    return b;
  }
  function packageFindFirst({ where }: any) {
    for (const p of state.packages.values()) {
      if (where.id && p.id !== where.id) continue;
      if (where.teacherId && p.teacherId !== where.teacherId) continue;
      return snapshot(p);
    }
    return null;
  }
  function packageUpdate({ where, data }: any) {
    const p = state.packages.get(where.id);
    if (!p) throw new Error(`no package ${where.id}`);
    if (data.classesUsed?.increment) p.classesUsed += data.classesUsed.increment;
    if (data.classesUsed?.decrement) p.classesUsed -= data.classesUsed.decrement;
    if (data.expiresAt) p.expiresAt = data.expiresAt;
    if (data.status) p.status = data.status;
    return p;
  }
  function packageUpdateMany({ where, data }: any) {
    const p = state.packages.get(where.id);
    if (!p) return { count: 0 };
    // Honor the column-compared capacity guard (classesUsed < classesTotal),
    // modeled via the `fields.classesTotal` sentinel below.
    if (where.classesUsed?.lt === "classesTotal" && !(p.classesUsed < p.classesTotal)) {
      return { count: 0 };
    }
    // Floor guard (packages_classes_used_bounds — Sentry 7590425327): a
    // refund/decrement must not push classes_used below 0.
    if (where.classesUsed?.gt !== undefined && !(p.classesUsed > where.classesUsed.gt)) {
      return { count: 0 };
    }
    // Floor guard for the schedule-change budget restore on waive of a ≥24h cancel.
    if (
      where.scheduleChangesUsed?.gt !== undefined &&
      !(p.scheduleChangesUsed > where.scheduleChangesUsed.gt)
    ) {
      return { count: 0 };
    }
    if (data.classesUsed?.increment) p.classesUsed += data.classesUsed.increment;
    if (data.classesUsed?.decrement) p.classesUsed -= data.classesUsed.decrement;
    if (data.scheduleChangesUsed?.increment)
      p.scheduleChangesUsed += data.scheduleChangesUsed.increment;
    if (data.scheduleChangesUsed?.decrement)
      p.scheduleChangesUsed -= data.scheduleChangesUsed.decrement;
    if (data.status) p.status = data.status;
    return { count: 1 };
  }
  function bookingUpdateMany({ where, data }: any) {
    const b = state.bookings.get(where.id);
    if (!b) return { count: 0 };
    // Status guard accepts either an exact string or a Prisma `{ in: [...] }`
    // filter (mark_no_show guards on both "scheduled" and "completed").
    if (where.status !== undefined) {
      const matches =
        typeof where.status === "object" && Array.isArray(where.status.in)
          ? where.status.in.includes(b.status)
          : b.status === where.status;
      if (!matches) return { count: 0 };
    }
    Object.assign(b, data);
    return { count: 1 };
  }
  function overrideCreate({ data }: any) {
    const row: OverrideRow = {
      id: `override-${state.overrides.length + 1}`,
      ...data,
    };
    state.overrides.push(row);
    return row;
  }
  function teacherStudentFindUnique({ where }: any) {
    const { teacherId, studentId } = where.teacherId_studentId;
    const link = state.teacherStudents.find(
      (l) => l.teacherId === teacherId && l.studentId === studentId,
    );
    return snapshot(link ?? null);
  }
  function teacherStudentUpdate({ where, data }: any) {
    const { teacherId, studentId } = where.teacherId_studentId;
    const link = state.teacherStudents.find(
      (l) => l.teacherId === teacherId && l.studentId === studentId,
    );
    if (!link) throw new Error("no teacherStudent");
    if ("customPriceMinorUnits" in data) link.customPriceMinorUnits = data.customPriceMinorUnits;
    if ("archivedAt" in data) link.archivedAt = data.archivedAt;
    if ("archivedReason" in data) link.archivedReason = data.archivedReason;
    return link;
  }
  function notificationCreate({ data, select }: any) {
    const row: NotificationRow = {
      id: `notif-${state.notifications.length + 1}`,
      teacherId: data.teacherId,
      recipientType: data.recipientType,
      recipientId: data.recipientId,
      bookingId: data.bookingId ?? null,
      paymentId: data.paymentId ?? null,
      channel: data.channel,
      templateName: data.templateName,
      status: data.status ?? "queued",
    };
    state.notifications.push(row);
    if (select?.id) return { id: row.id };
    return row;
  }
  const tx = {
    booking: {
      update: bookingUpdate,
      updateMany: bookingUpdateMany,
      findUnique: bookingFindUnique,
    },
    package: {
      update: packageUpdate,
      updateMany: packageUpdateMany,
      fields: { classesTotal: "classesTotal" },
    },
    override: { create: overrideCreate },
    teacherStudent: { update: teacherStudentUpdate },
    teacherStudentTemplatePrice: {
      upsert: async ({
        where,
        create,
      }: {
        where: Record<string, never>;
        create: Record<string, unknown>;
      }) => {
        const w = (where as Record<string, { studentId: string; templateId: string }>)
          .teacherId_studentId_templateId;
        state.agreedPrices.set(`${w.studentId}:${w.templateId}`, create.priceMinorUnits as number);
        return create;
      },
      deleteMany: async ({ where }: { where: { studentId: string; templateId?: string } }) => {
        for (const key of [...state.agreedPrices.keys()]) {
          const [studentId, templateId] = key.split(":");
          if (studentId !== where.studentId) continue;
          if (where.templateId && templateId !== where.templateId) continue;
          state.agreedPrices.delete(key);
        }
        return { count: 0 };
      },
    },
    notification: { create: notificationCreate },
  };
  return {
    prisma: {
      booking: { findFirst: bookingFindFirst, findUnique: bookingFindUnique },
      package: { findFirst: packageFindFirst },
      teacherStudent: { findUnique: teacherStudentFindUnique },
      // Every template named in a save must belong to the caller — the action
      // re-checks ownership because the ids come from a client-rendered form.
      packageTemplate: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => id === TEMPLATE_ID).map((id) => ({ id })),
      },
      teacherStudentTemplatePrice: {
        findMany: async ({ where }: { where: { studentId: string } }) =>
          [...state.agreedPrices.entries()]
            .filter(([key]) => key.split(":")[0] === where.studentId)
            .map(([key, priceMinorUnits]) => ({ templateId: key.split(":")[1], priceMinorUnits })),
      },
      override: { create: overrideCreate },
      // Entitlement gate (custom price is Pro-only): an active subscription so
      // these override tests exercise the Pro path.
      teacherSubscription: {
        findUnique: async () => ({
          plan: "monthly",
          status: "active",
          comped: false,
          trialEndsAt: null,
          currentPeriodEnd: null,
        }),
      },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const {
  markBookingComplete,
  markBookingNoShow,
  restoreClass,
  waiveCancellation,
  extendPackageExpiration,
  setStudentCustomPrice,
  toggleStudentArchive,
  updateBookingLanguageOverrideAction,
} = await import("@/app/actions/overrides");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  freshState();
  trackServerEventMock.mockClear();
  inngestSendMock.mockClear();
  enqueueMock.mockClear();
  revalidatePathMock.mockClear();
});

describe("markBookingComplete", () => {
  it("flips scheduled → completed (quota-neutral under Model B), writes override + event", async () => {
    const result = await markBookingComplete(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Alumno avisó por WhatsApp" }),
    );
    expect(result?.ok).toMatch(/completa/);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("completed");
    expect(state.bookings.get(BOOKING_ID)?.completedAt).toBeInstanceOf(Date);
    // Already counted at reservation — completing doesn't move classesUsed.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "booking",
      targetId: BOOKING_ID,
      action: "mark_complete",
      reason: "Alumno avisó por WhatsApp",
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        properties: expect.objectContaining({ action: "mark_complete" }),
      }),
    );
  });

  it("rejects when booking is already completed", async () => {
    state.bookings.get(BOOKING_ID)!.status = "completed";
    const result = await markBookingComplete(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Doble click" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides).toHaveLength(0);
  });

  it("rejects when reason is too short", async () => {
    const result = await markBookingComplete(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "ab" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  it(": refuses cross-tenant booking lookup", async () => {
    state.bookings.get(BOOKING_ID)!.teacherId = OTHER_TEACHER_ID;
    const result = await markBookingComplete(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Tenant bypass attempt" }),
    );
    expect(result?.error).toMatch(/no encontramos/i);
    expect(state.overrides).toHaveLength(0);
  });

  // Regression: the complete flip must be status-guarded — a double-submit
  // passed the pre-check twice, and an unguarded update wrote a second Override
  // audit row for one action.
  it("does not write a duplicate override when a concurrent complete wins between the pre-check and the flip", async () => {
    const { prisma } = await import("@/lib/prisma");
    const original = prisma.$transaction.bind(prisma) as (
      fn: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction");
    spy.mockImplementationOnce((async (fn: (tx: unknown) => Promise<unknown>) => {
      // The concurrent complete lands after our pre-check read.
      state.bookings.get(BOOKING_ID)!.status = "completed";
      return original(fn);
    }) as unknown as typeof prisma.$transaction);
    const result = await markBookingComplete(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Doble clic en completar" }),
    );
    spy.mockRestore();
    expect(result?.error).toMatch(/ya fue modificada/i);
    // The guarded flip matched no row — no duplicate audit row.
    expect(state.overrides).toHaveLength(0);
  });
});

describe("markBookingNoShow", () => {
  it("flips scheduled → no_show (quota-neutral; class stays committed), writes override + queues no_show_student", async () => {
    const result = await markBookingNoShow(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Alumno no se conectó" }),
    );
    expect(result?.ok).toMatch(/no asistencia/i);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("no_show");
    // No-show forfeits the already-counted class — classesUsed is unchanged.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "booking",
      targetId: BOOKING_ID,
      action: "mark_no_show",
      reason: "Alumno no se conectó",
      beforeJson: { status: "scheduled" },
      afterJson: { status: "no_show" },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        properties: expect.objectContaining({ action: "mark_no_show" }),
      }),
    );
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      teacherId: TEACHER_ID,
      recipientType: "student",
      recipientId: STUDENT_ID,
      bookingId: BOOKING_ID,
      templateName: "no_show_student",
      status: "queued",
    });
    expect(enqueueMock).toHaveBeenCalledWith(
      "notification.queued",
      expect.objectContaining({
        notificationId: state.notifications[0].id,
        teacherId: TEACHER_ID,
      }),
    );
  });

  it("relabels an already-completed class → no_show (quota-neutral, clears completedAt)", async () => {
    const b = state.bookings.get(BOOKING_ID)!;
    b.status = "completed";
    b.completedAt = new Date("2026-05-10T16:50:00.000Z");
    const result = await markBookingNoShow(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "No se conectó; ya se había autocompletado" }),
    );
    expect(result?.ok).toMatch(/no asistencia/i);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("no_show");
    // Relabel clears the auto-complete stamp so no_show rows stay consistent.
    expect(state.bookings.get(BOOKING_ID)?.completedAt).toBeNull();
    // Still quota-neutral — the class was counted at reservation.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides[0]).toMatchObject({
      action: "mark_no_show",
      beforeJson: { status: "completed" },
      afterJson: { status: "no_show" },
    });
    // The student is still notified of the no-show on relabel.
    expect(state.notifications).toHaveLength(1);
  });

  it("rejects when booking is canceled (not no-showable)", async () => {
    state.bookings.get(BOOKING_ID)!.status = "canceled_by_student";
    const result = await markBookingNoShow(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Estado no válido para no-show" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides).toHaveLength(0);
  });

  it("rejects when reason is too short", async () => {
    const result = await markBookingNoShow(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "ok" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
    expect(state.overrides).toHaveLength(0);
  });

  it(": refuses cross-tenant booking lookup", async () => {
    state.bookings.get(BOOKING_ID)!.teacherId = OTHER_TEACHER_ID;
    const result = await markBookingNoShow(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Tenant bypass attempt" }),
    );
    expect(result?.error).toMatch(/no encontramos/i);
    expect(state.overrides).toHaveLength(0);
  });

  // Regression: the no_show flip must be status-guarded — a double-submit
  // passed the pre-check twice, and an unguarded update wrote a second Override
  // row and enqueued a second no-show notification to the student for one action.
  it("does not duplicate the override or notification when a concurrent action wins the race", async () => {
    const { prisma } = await import("@/lib/prisma");
    const original = prisma.$transaction.bind(prisma) as (
      fn: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction");
    spy.mockImplementationOnce((async (fn: (tx: unknown) => Promise<unknown>) => {
      // A concurrent no_show lands after our pre-check read.
      state.bookings.get(BOOKING_ID)!.status = "no_show";
      return original(fn);
    }) as unknown as typeof prisma.$transaction);
    const result = await markBookingNoShow(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Doble toque en no-show" }),
    );
    spy.mockRestore();
    expect(result?.error).toMatch(/ya fue modificada/i);
    // The guarded flip matched no row — no duplicate audit row or notification.
    expect(state.overrides).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("restoreClass", () => {
  beforeEach(() => {
    // A ≥24h cancel was released (flag off) — restoring re-claims a slot.
    state.bookings.get(BOOKING_ID)!.status = "canceled_by_student";
    state.bookings.get(BOOKING_ID)!.countsAgainstPackage = false;
    state.packages.get(PACKAGE_ID)!.classesUsed = 4;
  });

  it("re-commits a released cancel: → scheduled, increments classesUsed, re-emits booking.created", async () => {
    const result = await restoreClass(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Cancelación por error" }),
    );
    expect(result?.ok).toMatch(/restaurada/);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
    expect(state.bookings.get(BOOKING_ID)?.countsAgainstPackage).toBe(true);
    // Re-claims one slot back into the committed count.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(5);
    expect(state.overrides[0]).toMatchObject({
      action: "restore_class",
      beforeJson: { status: "canceled_by_student" },
      afterJson: { status: "scheduled" },
    });
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "booking.created",
        data: expect.objectContaining({ bookingId: BOOKING_ID }),
      }),
    );
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ action: "restore_class" }),
      }),
    );
  });

  it("is quota-neutral when restoring a still-committed no_show (flag on)", async () => {
    state.bookings.get(BOOKING_ID)!.status = "no_show";
    state.bookings.get(BOOKING_ID)!.countsAgainstPackage = true;
    const result = await restoreClass(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Mala marca de no-show" }),
    );
    expect(result?.ok).toBeTruthy();
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
    // Was never released, so no re-claim — classesUsed unchanged.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(4);
  });

  it("refuses to re-commit when the package is already full", async () => {
    state.packages.get(PACKAGE_ID)!.classesUsed = 10; // == classesTotal
    const result = await restoreClass(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "No room left" }),
    );
    expect(result?.error).toMatch(/no tiene clases/i);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
    expect(state.overrides).toHaveLength(0);
  });

  it("refuses to restore when the slot is now occupied by another scheduled booking", async () => {
    const otherId = "66666666-6666-4666-8666-666666666666";
    state.bookings.set(otherId, {
      id: otherId,
      teacherId: TEACHER_ID,
      studentId: "ssss-other",
      packageId: PACKAGE_ID,
      status: "scheduled",
      countsAgainstPackage: true,
      scheduledStart: state.bookings.get(BOOKING_ID)!.scheduledStart,
      scheduledEnd: state.bookings.get(BOOKING_ID)!.scheduledEnd,
      completedAt: null,
      teacherLanguageOverride: null,
      studentLanguageOverride: null,
    });
    const result = await restoreClass(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Conflict path" }),
    );
    expect(result?.error).toMatch(/ocupado/i);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
    expect(state.overrides).toHaveLength(0);
  });

  it("rejects restore on a still-scheduled booking", async () => {
    state.bookings.get(BOOKING_ID)!.status = "scheduled";
    const result = await restoreClass(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Wrong status" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
  });
});

describe("waiveCancellation", () => {
  beforeEach(() => {
    // A <24h cancel that kept its penalty (flag on) — waiving refunds it.
    state.bookings.get(BOOKING_ID)!.status = "canceled_by_student";
    state.bookings.get(BOOKING_ID)!.countsAgainstPackage = true;
    state.packages.get(PACKAGE_ID)!.classesUsed = 4;
  });

  it("refunds a still-committed (<24h) cancel: → canceled_by_teacher, decrements classesUsed", async () => {
    const result = await waiveCancellation(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Se enfermó, fue mi culpa por la regla" }),
    );
    expect(result?.ok).toMatch(/perdonada/);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    expect(state.bookings.get(BOOKING_ID)?.countsAgainstPackage).toBe(false);
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides[0]).toMatchObject({
      action: "waive_cancellation",
      beforeJson: { status: "canceled_by_student" },
      afterJson: { status: "canceled_by_teacher" },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ action: "waive_cancellation" }),
      }),
    );
  });

  it("restores the schedule-change unit a ≥24h cancel spent (no second class refund)", async () => {
    // A ≥24h cancel already returned the class (flag off) but spent one pooled
    // schedule-change unit. Waiving it forgives the move too.
    state.bookings.get(BOOKING_ID)!.countsAgainstPackage = false;
    state.packages.get(PACKAGE_ID)!.scheduleChangesUsed = 2;
    const result = await waiveCancellation(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Ya se había reembolsado" }),
    );
    expect(result?.ok).toMatch(/perdonada/);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    // The class was already released at cancel time — no second refund…
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(4);
    // …but the schedule-change unit it consumed is handed back.
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(1);
  });

  it("still succeeds when the schedule-change budget is already at its floor (restore skipped)", async () => {
    state.bookings.get(BOOKING_ID)!.countsAgainstPackage = false;
    state.packages.get(PACKAGE_ID)!.scheduleChangesUsed = 0;
    const result = await waiveCancellation(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Sin unidad que devolver" }),
    );
    // The waive still succeeds — a pre-existing anomaly must not block it, and
    // the floor-guarded updateMany matched no row so nothing underflows.
    expect(result?.ok).toMatch(/perdonada/);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(0);
  });

  it("rejects when booking isn't a student cancellation", async () => {
    state.bookings.get(BOOKING_ID)!.status = "completed";
    const result = await waiveCancellation(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Wrong status" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(4);
    expect(state.overrides).toHaveLength(0);
  });

  // Regression for Sentry 7590425327: PrismaClientUnknownRequestError /
  // packages_classes_used_bounds CHECK violation. A plain `package.update`
  // decrement had no floor guard, so a package already at classes_used: 0
  // (invariant already broken upstream) crashed with a raw 500 instead of
  // succeeding with the impossible decrement simply skipped.
  it("still succeeds when classes_used is already at its floor", async () => {
    state.packages.get(PACKAGE_ID)!.classesUsed = 0;
    const result = await waiveCancellation(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Se enfermó, fue mi culpa por la regla" }),
    );
    expect(result?.ok).toMatch(/perdonada/);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    // Never negative — the floor-guarded updateMany matched no row.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(0);
    expect(state.overrides[0]).toMatchObject({ action: "waive_cancellation" });
  });

  // Regression: the waive flip must be status-guarded — a double-submit
  // passed the pre-check twice, and the second unguarded flip refunded the
  // same class again (classes_used decremented twice for one waive).
  it("does not double-refund when a concurrent waive wins between the pre-check and the flip", async () => {
    const { prisma } = await import("@/lib/prisma");
    const original = prisma.$transaction.bind(prisma) as (
      fn: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction");
    spy.mockImplementationOnce((async (fn: (tx: unknown) => Promise<unknown>) => {
      // The concurrent waive lands after our pre-check read: it already
      // flipped the booking and refunded the class.
      state.bookings.get(BOOKING_ID)!.status = "canceled_by_teacher";
      state.bookings.get(BOOKING_ID)!.countsAgainstPackage = false;
      state.packages.get(PACKAGE_ID)!.classesUsed = 3;
      return original(fn);
    }) as unknown as typeof prisma.$transaction);
    const result = await waiveCancellation(
      undefined,
      form({ bookingId: BOOKING_ID, reason: "Doble clic en la misma clase" }),
    );
    spy.mockRestore();
    expect(result?.error).toMatch(/ya fue modificada/i);
    // The winner's single refund stands — no second decrement, no audit row.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);
    expect(state.overrides).toHaveLength(0);
  });
});

describe("extendPackageExpiration", () => {
  // The two boundary checks (future-date first, then posterior-to-current) are
  // wall-clock sensitive, and the fixture expiry is a fixed 2026-08-01. Pin
  // "now" to an instant before both the fixture expiry and the 2026-07-01 case
  // below, so the "posterior a la actual" branch is what's exercised — not the
  // "must be in the future" guard — no matter when the suite runs. (Only Date
  // is faked; real timers are left alone so awaits behave normally.)
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the new date as end-of-day in the teacher's IANA tz, not UTC", async () => {
    const result = await extendPackageExpiration(
      undefined,
      form({
        packageId: PACKAGE_ID,
        newExpiresAt: "2026-09-30",
        reason: "Vacaciones del alumno",
      }),
    );
    expect(result?.ok).toBeTruthy();
    const pkg = state.packages.get(PACKAGE_ID)!;
    // Sept 30 23:59:59 in America/Mexico_City (CST = -06:00) =
    // Oct 1 05:59:59 UTC.
    expect(pkg.expiresAt?.toISOString()).toBe("2026-10-01T05:59:59.000Z");
    expect(state.overrides[0]).toMatchObject({
      action: "extend_expiration",
      targetType: "package",
      afterJson: { expiresAt: "2026-10-01T05:59:59.000Z" },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        properties: expect.objectContaining({
          action: "extend_expiration",
          previousValue: "2026-08-01T05:59:59.000Z",
          newValue: "2026-10-01T05:59:59.000Z",
        }),
      }),
    );
  });

  it("rejects a date earlier than the current expiration", async () => {
    const result = await extendPackageExpiration(
      undefined,
      form({
        packageId: PACKAGE_ID,
        // In the future (so it clears the "must be in the future" guard) but
        // before the current 2026-08-01 expiry, to exercise the "must be after
        // the current one" branch specifically.
        newExpiresAt: "2026-07-15",
        reason: "Atrás del actual",
      }),
    );
    expect(result?.error).toMatch(/posterior/i);
    // Existing expiresAt unchanged.
    expect(state.packages.get(PACKAGE_ID)?.expiresAt?.toISOString()).toBe(
      "2026-08-01T05:59:59.000Z",
    );
    expect(state.overrides).toHaveLength(0);
  });

  it("rejects malformed dates from the form", async () => {
    const result = await extendPackageExpiration(
      undefined,
      form({
        packageId: PACKAGE_ID,
        newExpiresAt: "next month",
        reason: "Bad input",
      }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
  });

  it(": refuses cross-tenant package lookup", async () => {
    state.packages.get(PACKAGE_ID)!.teacherId = OTHER_TEACHER_ID;
    const result = await extendPackageExpiration(
      undefined,
      form({
        packageId: PACKAGE_ID,
        newExpiresAt: "2026-09-30",
        reason: "Tenant bypass",
      }),
    );
    expect(result?.error).toMatch(/no encontrado/i);
    expect(state.overrides).toHaveLength(0);
  });
});

describe("updateBookingLanguageOverrideAction", () => {
  it("sets both language overrides and writes an override row", async () => {
    const result = await updateBookingLanguageOverrideAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        teacherLanguage: "fr",
        studentLanguage: "de",
        reason: "Practicing in French today",
      }),
    );
    expect(result?.ok).toBeTruthy();
    const booking = state.bookings.get(BOOKING_ID)!;
    expect(booking.teacherLanguageOverride).toBe("fr");
    expect(booking.studentLanguageOverride).toBe("de");
    expect(state.overrides[0]).toMatchObject({
      action: "set_class_language",
      targetType: "booking",
      afterJson: { teacherLanguageOverride: "fr", studentLanguageOverride: "de" },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        properties: expect.objectContaining({
          action: "set_class_language",
          previousValue: "/",
          newValue: "fr/de",
        }),
      }),
    );
  });

  it("empty string clears an override back to the default (null)", async () => {
    state.bookings.get(BOOKING_ID)!.teacherLanguageOverride = "fr";
    state.bookings.get(BOOKING_ID)!.studentLanguageOverride = "de";
    const result = await updateBookingLanguageOverrideAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        teacherLanguage: "",
        studentLanguage: "",
        reason: "Back to normal",
      }),
    );
    expect(result?.ok).toBeTruthy();
    const booking = state.bookings.get(BOOKING_ID)!;
    expect(booking.teacherLanguageOverride).toBeNull();
    expect(booking.studentLanguageOverride).toBeNull();
  });

  it("rejects an unsupported language code", async () => {
    const result = await updateBookingLanguageOverrideAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        teacherLanguage: "xx",
        studentLanguage: "",
        reason: "Bad code",
      }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.bookings.get(BOOKING_ID)?.teacherLanguageOverride).toBeNull();
    expect(state.overrides).toHaveLength(0);
  });

  it("rejects a reason that's too short", async () => {
    const result = await updateBookingLanguageOverrideAction(
      undefined,
      form({ bookingId: BOOKING_ID, teacherLanguage: "fr", studentLanguage: "", reason: "x" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
  });

  it(": refuses cross-tenant booking lookup", async () => {
    state.bookings.get(BOOKING_ID)!.teacherId = OTHER_TEACHER_ID;
    const result = await updateBookingLanguageOverrideAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        teacherLanguage: "fr",
        studentLanguage: "",
        reason: "Tenant bypass",
      }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
  });
});

describe("setStudentCustomPrice", () => {
  const prices = (rows: Array<{ templateId: string; minorUnits: number | null }>) =>
    JSON.stringify(rows);

  it("sets an agreed price for one package + writes override row", async () => {
    const result = await setStudentCustomPrice(
      undefined,
      form({
        studentId: STUDENT_ID,
        pricesJson: prices([{ templateId: TEMPLATE_ID, minorUnits: 120000 }]),
        reason: "Alumno desde 2018, precio histórico",
      }),
    );
    expect(result?.ok).toMatch(/actualizado/);
    expect(state.agreedPrices.get(`${STUDENT_ID}:${TEMPLATE_ID}`)).toBe(120000);
    expect(state.overrides[0]).toMatchObject({
      action: "set_custom_price",
      targetType: "student",
      targetId: STUDENT_ID,
      beforeJson: { pricesByTemplate: {} },
      afterJson: { pricesByTemplate: { [TEMPLATE_ID]: 120000 } },
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        properties: expect.objectContaining({ action: "set_custom_price" }),
      }),
    );
  });

  it("clears one package's agreed price when its entry is null", async () => {
    state.agreedPrices.set(`${STUDENT_ID}:${TEMPLATE_ID}`, 99999);
    const result = await setStudentCustomPrice(
      undefined,
      form({
        studentId: STUDENT_ID,
        pricesJson: prices([{ templateId: TEMPLATE_ID, minorUnits: null }]),
        reason: "Removing grandfathered price",
      }),
    );
    expect(result?.ok).toMatch(/eliminado/);
    expect(state.agreedPrices.has(`${STUDENT_ID}:${TEMPLATE_ID}`)).toBe(false);
    expect(state.overrides[0].afterJson).toMatchObject({ pricesByTemplate: {} });
  });

  it("rejects non-integer / negative / oversized prices", async () => {
    for (const bad of [-100, 1.5, 100000000]) {
      trackServerEventMock.mockClear();
      const result = await setStudentCustomPrice(
        undefined,
        form({
          studentId: STUDENT_ID,
          pricesJson: prices([{ templateId: TEMPLATE_ID, minorUnits: bad }]),
          reason: "Bad input attempt",
        }),
      );
      expect(result?.error).toBeTruthy();
      expect(trackServerEventMock).not.toHaveBeenCalled();
    }
    // No override rows were created across the bad-input attempts.
    expect(state.overrides).toHaveLength(0);
  });

  // The ids come from a client-rendered form and the composite FK only
  // constrains the pairing — it would accept another teacher's template.
  it("refuses a template that isn't this teacher's", async () => {
    const result = await setStudentCustomPrice(
      undefined,
      form({
        studentId: STUDENT_ID,
        pricesJson: prices([
          { templateId: "9f1d4c6a-1111-4111-8111-111111111111", minorUnits: 1000 },
        ]),
        reason: "Cross-tenant attempt",
      }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
  });

  it("tenant isolation: refuses when student isn't linked to this teacher", async () => {
    state.teacherStudents.length = 0;
    const result = await setStudentCustomPrice(
      undefined,
      form({
        studentId: STUDENT_ID,
        pricesJson: JSON.stringify([{ templateId: TEMPLATE_ID, minorUnits: 100000 }]),
        reason: "Tenant bypass",
      }),
    );
    expect(result?.error).toMatch(/no está/i);
    expect(state.overrides).toHaveLength(0);
  });
});

describe("toggleStudentArchive", () => {
  it("archives an active link: sets archivedAt + reason, writes audit row + event", async () => {
    const result = await toggleStudentArchive(
      undefined,
      form({ studentId: STUDENT_ID, intent: "archive", reason: "Pausa por ahora" }),
    );
    expect(result?.ok).toMatch(/baja/i);
    const link = state.teacherStudents.find((l) => l.studentId === STUDENT_ID);
    expect(link?.archivedAt).toBeInstanceOf(Date);
    expect(link?.archivedReason).toBe("Pausa por ahora");
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "student",
      targetId: STUDENT_ID,
      action: "archive_student",
      reason: "Pausa por ahora",
    });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "override_applied",
        properties: expect.objectContaining({ action: "archive_student" }),
      }),
    );
  });

  it("archives with no reason: falls back to a default audit reason", async () => {
    const result = await toggleStudentArchive(
      undefined,
      form({ studentId: STUDENT_ID, intent: "archive" }),
    );
    expect(result?.ok).toBeTruthy();
    const link = state.teacherStudents.find((l) => l.studentId === STUDENT_ID);
    expect(link?.archivedAt).toBeInstanceOf(Date);
    // A default reason is stored so the audit row stays meaningful.
    expect(link?.archivedReason).toBeTruthy();
    expect(state.overrides[0]?.action).toBe("archive_student");
  });

  it("reactivates an archived link: clears the flag, writes reactivate audit row", async () => {
    const link = state.teacherStudents.find((l) => l.studentId === STUDENT_ID)!;
    link.archivedAt = new Date("2026-05-01T00:00:00.000Z");
    link.archivedReason = "Old reason";

    const result = await toggleStudentArchive(
      undefined,
      form({ studentId: STUDENT_ID, intent: "reactivate" }),
    );
    expect(result?.ok).toMatch(/reactiv/i);
    expect(link.archivedAt).toBeNull();
    expect(link.archivedReason).toBeNull();
    expect(state.overrides[0]).toMatchObject({ action: "reactivate_student" });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ action: "reactivate_student" }),
      }),
    );
  });

  it("rejects archiving an already-archived link (no double audit row)", async () => {
    const link = state.teacherStudents.find((l) => l.studentId === STUDENT_ID)!;
    link.archivedAt = new Date("2026-05-01T00:00:00.000Z");
    const result = await toggleStudentArchive(
      undefined,
      form({ studentId: STUDENT_ID, intent: "archive" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  it("rejects reactivating a link that is already active", async () => {
    const result = await toggleStudentArchive(
      undefined,
      form({ studentId: STUDENT_ID, intent: "reactivate" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.overrides).toHaveLength(0);
  });

  it("tenant isolation: refuses when student isn't linked to this teacher", async () => {
    state.teacherStudents.length = 0;
    const result = await toggleStudentArchive(
      undefined,
      form({ studentId: STUDENT_ID, intent: "archive" }),
    );
    expect(result?.error).toMatch(/no está/i);
    expect(state.overrides).toHaveLength(0);
  });
});
