import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Item 10 — teacher self-serve booking. Covers the new createTeacherBooking
// action's authorization (tenancy) and the rule split it relies on:
//   * minAdvanceH is bypassed — a slot inside the teacher's lead-time window
//     books, where the student flow would reject it.
//   * availability windows, blocked dates and collisions are NOT bypassed.
//   * a successful booking enqueues the student confirmation only (no
//     booking_created_teacher), writes a teacher_book_class override, and
//     fires booking.created so reminders / auto-complete fan out.
//
// generateSlots runs for real (it's a pure slot generation function), so the bypass is
// exercised end-to-end rather than stubbed. Only the data + side-effect layers
// are faked, mirroring the overrides action test.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "44444444-4444-4444-8444-444444444444";
const TEACHER_TZ = "America/Mexico_City"; // UTC-6, no DST since 2022

// Fixed clock: Monday 2026-06-15 08:00 local (14:00Z). The availability rule
// below opens at 10:00 local, so the first bookable slot is 16:00Z — two hours
// out, well inside a 24h minAdvanceH window.
const NOW = new Date("2026-06-15T14:00:00.000Z");
const SLOT_10AM = "2026-06-15T16:00:00.000Z"; // 10:00 local Monday
const SLOT_9AM = "2026-06-15T15:00:00.000Z"; // 09:00 local — before the window

type PackageRow = {
  id: string;
  teacherId: string;
  studentId: string;
  classesUsed: number;
  classesTotal: number;
  classDurationMin: number;
  expiresAt: Date | null;
  purchasedAt: Date;
  status: string;
  templateId: string | null;
  template: { name: string; singleClass: boolean } | null;
};
type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
};
type OverrideRow = {
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  afterJson: unknown;
};
type NotificationRow = {
  teacherId: string;
  recipientType: string;
  recipientId: string;
  bookingId: string | null;
  templateName: string;
};
type AvailabilityRuleRow = {
  teacherId: string;
  weekday: number;
  startTime: string;
  endTime: string;
};

type FakeState = {
  packages: Map<string, PackageRow>;
  bookings: BookingRow[];
  overrides: OverrideRow[];
  notifications: NotificationRow[];
  availabilityRules: AvailabilityRuleRow[];
};

const state: FakeState = {
  packages: new Map(),
  bookings: [],
  overrides: [],
  notifications: [],
  availabilityRules: [],
};

function freshState() {
  state.packages.clear();
  state.bookings.length = 0;
  state.overrides.length = 0;
  state.notifications.length = 0;
  state.availabilityRules.length = 0;

  state.packages.set(PACKAGE_ID, {
    id: PACKAGE_ID,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    classesUsed: 2,
    classesTotal: 10,
    classDurationMin: 50,
    expiresAt: null,
    purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
    status: "active",
    templateId: "tmpl-1",
    template: { name: "10 clases de 50 min", singleClass: false },
  });
  // Monday (weekday 1) 10:00–12:00 local.
  state.availabilityRules.push({
    teacherId: TEACHER_ID,
    weekday: 1,
    startTime: "10:00",
    endTime: "12:00",
  });
}

const trackServerEventMock = vi.fn();
const inngestSendMock = vi.fn();
const emitNotificationQueuedMock = vi.fn();
const revalidatePathMock = vi.fn();

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
const redirectMock = vi.fn((url: string) => {
  throw new RedirectError(url);
});

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({
    id: TEACHER_ID,
    name: "Prof. Mira",
    timezone: TEACHER_TZ,
    bufferMin: 0,
    minAdvanceH: 24,
    maxAdvanceDays: 30,
  })),
}));

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: vi.fn(),
}));

vi.mock("@/lib/inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: emitNotificationQueuedMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/prisma", () => {
  function snapshot<T>(row: T | null): T | null {
    return row ? ({ ...(row as object) } as T) : null;
  }
  function packageFindFirst({ where }: any) {
    for (const p of state.packages.values()) {
      if (where.id && p.id !== where.id) continue;
      if (where.teacherId && p.teacherId !== where.teacherId) continue;
      if (where.status && p.status !== where.status) continue;
      return snapshot(p);
    }
    return null;
  }
  function packageFindMany({ where }: any) {
    const out: PackageRow[] = [];
    for (const p of state.packages.values()) {
      if (where?.teacherId && p.teacherId !== where.teacherId) continue;
      if (where?.studentId?.in && !where.studentId.in.includes(p.studentId)) continue;
      if (where?.classDurationMin !== undefined && p.classDurationMin !== where.classDurationMin)
        continue;
      if (where?.status && p.status !== where.status) continue;
      out.push(snapshot(p)!);
    }
    return out;
  }
  function packageUpdateMany({ where, data }: any) {
    let count = 0;
    for (const p of state.packages.values()) {
      if (where.id && p.id !== where.id) continue;
      if (where.status && p.status !== where.status) continue;
      // `classesUsed: { lt: fields.classesTotal }` — compare against the row.
      if (where.classesUsed?.lt && !(p.classesUsed < p.classesTotal)) continue;
      if (data.classesUsed?.increment) p.classesUsed += data.classesUsed.increment;
      count += 1;
    }
    return { count };
  }
  function bookingFindMany({ where }: any) {
    return state.bookings
      .filter((b) => {
        if (where.teacherId && b.teacherId !== where.teacherId) return false;
        if (where.status && b.status !== where.status) return false;
        if (where.scheduledStart?.gte && b.scheduledStart < where.scheduledStart.gte) return false;
        if (where.scheduledStart?.lt && b.scheduledStart >= where.scheduledStart.lt) return false;
        return true;
      })
      .map((b) => ({ scheduledStart: b.scheduledStart, scheduledEnd: b.scheduledEnd }));
  }
  function bookingCreate({ data }: any) {
    const row: BookingRow = {
      id: `booking-${state.bookings.length + 1}`,
      teacherId: data.teacherId,
      studentId: data.studentId,
      packageId: data.packageId,
      status: data.status,
      scheduledStart: data.scheduledStart,
      scheduledEnd: data.scheduledEnd,
    };
    state.bookings.push(row);
    return row;
  }
  function notificationCreate({ data, select }: any) {
    const row: NotificationRow = {
      teacherId: data.teacherId,
      recipientType: data.recipientType,
      recipientId: data.recipientId,
      bookingId: data.bookingId ?? null,
      templateName: data.templateName,
    };
    state.notifications.push(row);
    const id = `notif-${state.notifications.length}`;
    return select?.id ? { id } : { ...row, id };
  }
  function overrideCreate({ data }: any) {
    state.overrides.push({
      teacherId: data.teacherId,
      targetType: data.targetType,
      targetId: data.targetId,
      action: data.action,
      reason: data.reason,
      afterJson: data.afterJson,
    });
    return { id: `override-${state.overrides.length}` };
  }
  const tx = {
    package: { updateMany: packageUpdateMany, findMany: packageFindMany },
    booking: { create: bookingCreate },
    notification: { create: notificationCreate },
    override: { create: overrideCreate },
  };
  return {
    prisma: {
      package: {
        findFirst: packageFindFirst,
        findMany: packageFindMany,
        fields: { classesTotal: "classesTotal" },
      },
      availabilityRule: {
        findMany: ({ where }: any) =>
          state.availabilityRules.filter(
            (r) => !where?.teacherId || r.teacherId === where.teacherId,
          ),
      },
      blockedDate: { findMany: async () => [] },
      googleBusyInterval: { findMany: async () => [] },
      // count backs maybeEmitFirstBooking's post-create check (onboarding
      // activation audit) — reflects state.bookings so the "first
      // booking" test-shape stays realistic rather than always short-circuiting.
      booking: { findMany: bookingFindMany, count: async () => state.bookings.length },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { createTeacherBooking } = await import("@/app/actions/teacher-booking");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function book(fd: FormData) {
  try {
    const stateResult = await createTeacherBooking(undefined, fd);
    return { redirected: false as const, state: stateResult };
  } catch (e) {
    if (e instanceof RedirectError) return { redirected: true as const, url: e.url };
    throw e;
  }
}

beforeEach(() => {
  freshState();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  trackServerEventMock.mockClear();
  inngestSendMock.mockClear();
  emitNotificationQueuedMock.mockClear();
  revalidatePathMock.mockClear();
  redirectMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTeacherBooking", () => {
  it("bypasses minAdvanceH: books a slot inside the lead-time window the student couldn't", async () => {
    const result = await book(form({ packageId: PACKAGE_ID, startUtc: SLOT_10AM }));

    expect(result.redirected).toBe(true);
    if (result.redirected) expect(result.url).toMatch(/^\/dashboard\/classes\/booking-1$/);

    // Booking created against the package's own studentId, class claimed.
    expect(state.bookings).toHaveLength(1);
    expect(state.bookings[0]).toMatchObject({
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      status: "scheduled",
    });
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(3);

    // Student gets the normal confirmation; teacher does NOT get booking_created_teacher.
    expect(state.notifications.map((n) => n.templateName)).toEqual(["booking_confirmation"]);

    // Recorded like other teacher interventions.
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "booking",
      targetId: "booking-1",
      action: "teacher_book_class",
    });

    // booking.created fires (reminders + auto-complete) and analytics tags source.
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "booking.created" }),
    );
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "booking_created",
        properties: expect.objectContaining({
          source: "teacher",
          teacherId: TEACHER_ID,
          teacherName: "Prof. Mira",
          studentId: STUDENT_ID,
          bookingId: "booking-1",
          packageId: PACKAGE_ID,
          classId: "tmpl-1",
          className: "10 clases de 50 min",
          classType: "package",
          scheduledAt: SLOT_10AM,
        }),
      }),
    );
  });

  it("does NOT bypass availability windows: a slot outside working hours is rejected", async () => {
    const result = await book(form({ packageId: PACKAGE_ID, startUtc: SLOT_9AM }));

    expect(result.redirected).toBe(false);
    if (!result.redirected) expect(result.state?.error).toBeTruthy();
    expect(state.bookings).toHaveLength(0);
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.overrides).toHaveLength(0);
  });

  it("does NOT bypass collisions: a slot already taken (with buffer) is rejected", async () => {
    state.bookings.push({
      id: "existing",
      teacherId: TEACHER_ID,
      studentId: "99999999-9999-4999-8999-999999999999",
      packageId: "00000000-0000-4000-8000-000000000000",
      status: "scheduled",
      scheduledStart: new Date(SLOT_10AM),
      scheduledEnd: new Date("2026-06-15T16:50:00.000Z"),
    });

    const result = await book(form({ packageId: PACKAGE_ID, startUtc: SLOT_10AM }));

    expect(result.redirected).toBe(false);
    if (!result.redirected) expect(result.state?.error).toBeTruthy();
    // No NEW booking; the pre-existing one is untouched.
    expect(state.bookings).toHaveLength(1);
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
  });

  it("tenant isolation: refuses a package belonging to another teacher", async () => {
    state.packages.get(PACKAGE_ID)!.teacherId = OTHER_TEACHER_ID;

    const result = await book(form({ packageId: PACKAGE_ID, startUtc: SLOT_10AM }));

    expect(result.redirected).toBe(false);
    // The CODE, not a sentence: the action stopped returning wording of its own
    // (it had picked English-or-Spanish by ternary), so this no longer asserts a
    // Spanish string that a French teacher would never have seen anyway.
    if (!result.redirected) expect(result.state?.error).toBe("package-not-found");
    expect(state.bookings).toHaveLength(0);
  });

  it("rejects when the package has no classes left", async () => {
    const pkg = state.packages.get(PACKAGE_ID)!;
    pkg.classesUsed = pkg.classesTotal;

    const result = await book(form({ packageId: PACKAGE_ID, startUtc: SLOT_10AM }));

    expect(result.redirected).toBe(false);
    if (!result.redirected) expect(result.state?.error).toBeTruthy();
    expect(state.bookings).toHaveLength(0);
    expect(state.overrides).toHaveLength(0);
  });
});
