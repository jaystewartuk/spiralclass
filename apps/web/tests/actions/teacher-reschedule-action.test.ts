import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher "change date and time". The transaction lives in applyReschedule
// (covered in tests/cancellation/reschedule-handler.test.ts); this pins the
// action shell: validation → tenancy → status → future/same slot → package
// window → slot availability → apply → redirect, plus the two exemptions that
// make this a teacher action rather than a copy of the student one.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));
vi.mock("@/lib/calendar/google/busy", () => ({ loadGoogleBusyBlocks: vi.fn(async () => []) }));
vi.mock("@/lib/i18n", () => ({ getT: async () => (key: string) => key }));

const TEACHER = {
  id: "t1",
  timezone: "America/Mexico_City",
  bufferMin: 10,
  minAdvanceH: 24,
  maxAdvanceDays: 60,
};
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: vi.fn(async () => TEACHER) }));

const state = {
  booking: null as Record<string, unknown> | null,
  slotMatches: true,
  outcome: { code: "ok", newBookingId: "new1" } as { code: string; newBookingId?: string },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: vi.fn(async () => state.booking),
      findMany: vi.fn(async () => []),
    },
    availabilityRule: { findMany: vi.fn(async () => []) },
    blockedDate: { findMany: vi.fn(async () => []) },
  },
}));

// Typed shapes for the two mocks the assertions read arguments back out of —
// `vi.fn()` with no signature gives `mock.calls` an empty tuple type, so an
// untyped stub makes `calls[0][0]` a type error rather than a value.
type SlotArgs = {
  teacher: { timezone: string; bufferMin: number; minAdvanceH: number; maxAdvanceDays: number };
};
type RescheduleArgs = {
  oldBookingId: string;
  oldScheduledStart: Date;
  spendScheduleChange?: boolean;
  notifyTeacher?: boolean;
  override?: { action: string; reason: string } | null;
};

const generateSlots = vi.fn((_input: SlotArgs) =>
  state.slotMatches ? [{ startUtc: new Date(FUTURE) }] : [],
);
vi.mock("@/lib/slots", () => ({ generateSlots: (input: SlotArgs) => generateSlots(input) }));

const applyReschedule = vi.fn(async (_deps: unknown, _input: RescheduleArgs) => state.outcome);
vi.mock("@/lib/cancellation/reschedule-handler", () => ({ applyReschedule }));

const { rescheduleBookingAsTeacher } = await import("@/app/actions/teacher-reschedule");

const BK = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2027-01-01T15:00:00.000Z";
const CURRENT_START = new Date("2026-12-01T15:00:00Z");

function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("bookingId", BK);
  f.set("startUtc", FUTURE);
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

function booking(over: Record<string, unknown> = {}) {
  return {
    id: BK,
    teacherId: TEACHER.id,
    studentId: "s1",
    packageId: "pkg1",
    status: "scheduled",
    scheduledStart: CURRENT_START,
    rescheduleCount: 0,
    package: { classDurationMin: 50, expiresAt: null },
    ...over,
  };
}

async function run(f: FormData): Promise<{ error?: string } | { redirectTo: string }> {
  try {
    return (await rescheduleBookingAsTeacher(undefined, f)) ?? {};
  } catch (err) {
    if (err instanceof RedirectError) return { redirectTo: err.url };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.booking = booking();
  state.slotMatches = true;
  state.outcome = { code: "ok", newBookingId: "new1" };
});

describe("rescheduleBookingAsTeacher", () => {
  it("rejects invalid input", async () => {
    expect(await run(fd({ bookingId: "x" }))).toEqual({ error: "invalid" });
  });

  it("refuses a booking that is not this teacher's", async () => {
    // The findFirst is scoped by teacherId; a miss is another tenant's class.
    // Application-level scoping is the whole of the isolation here.
    state.booking = null;
    expect(await run(fd())).toEqual({ error: "booking-not-found" });
    expect(applyReschedule).not.toHaveBeenCalled();
  });

  it("refuses a class that already happened or was cancelled", async () => {
    for (const status of ["completed", "no_show", "canceled_by_student", "rescheduled"]) {
      state.booking = booking({ status });
      expect(await run(fd())).toEqual({ error: "not-scheduled" });
    }
    expect(applyReschedule).not.toHaveBeenCalled();
  });

  it("refuses a slot in the past", async () => {
    expect(await run(fd({ startUtc: "2020-01-01T00:00:00.000Z" }))).toEqual({ error: "past-slot" });
  });

  it("refuses a move to the time the class already has", async () => {
    // A no-op that would still audit an intervention and tell the student her
    // class had changed.
    expect(await run(fd({ startUtc: CURRENT_START.toISOString() }))).toEqual({
      error: "same-slot",
    });
    expect(applyReschedule).not.toHaveBeenCalled();
  });

  it("refuses a slot after the package expires", async () => {
    state.booking = booking({
      package: { classDurationMin: 50, expiresAt: new Date("2026-12-31T00:00:00Z") },
    });
    expect(await run(fd())).toEqual({ error: "package-expired" });
  });

  it("errors when the chosen slot is no longer on offer", async () => {
    state.slotMatches = false;
    expect(await run(fd())).toEqual({ error: "slot-unavailable" });
    expect(applyReschedule).not.toHaveBeenCalled();
  });

  it("bypasses only her own lead-time rule when re-validating the slot", async () => {
    await run(fd());
    // She is confirming a change she has already agreed; minAdvanceH is the
    // one generator input that describes her preference rather than reality.
    // Everything else must arrive untouched, or the picker would offer slots
    // that collide, or sit outside her availability.
    const passed = generateSlots.mock.calls[0][0];
    expect(passed.teacher.minAdvanceH).toBe(0);
    expect(passed.teacher.bufferMin).toBe(TEACHER.bufferMin);
    expect(passed.teacher.maxAdvanceDays).toBe(TEACHER.maxAdvanceDays);
    expect(passed.teacher.timezone).toBe(TEACHER.timezone);
  });

  it("does not spend the student's budget, does not mirror to herself, and audits the move", async () => {
    await run(fd());
    expect(applyReschedule).toHaveBeenCalledTimes(1);
    const input = applyReschedule.mock.calls[0][1];
    expect(input.spendScheduleChange).toBe(false);
    expect(input.notifyTeacher).toBe(false);
    expect(input.override).toEqual({
      action: "teacher_reschedule_class",
      reason: "teacherReschedule.overrideReason",
    });
    expect(input.oldBookingId).toBe(BK);
    expect(input.oldScheduledStart).toEqual(CURRENT_START);
  });

  it("maps a lost race to slot-taken and a vanished package to package-not-found", async () => {
    state.outcome = { code: "slot-conflict" };
    expect(await run(fd())).toEqual({ error: "slot-taken" });
    state.outcome = { code: "package-not-found" };
    expect(await run(fd())).toEqual({ error: "package-not-found" });
  });

  it("redirects to the replacement class on success", async () => {
    expect(await run(fd())).toEqual({ redirectTo: "/dashboard/classes/new1" });
  });
});
