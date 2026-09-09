import { beforeEach, describe, expect, it, vi } from "vitest";

// Reschedule action. The transaction lives in applyReschedule and the
// eligibility math in cancellation/classify (both covered separately); this
// pins the action shell's gate sequence: validation → ownership → eligibility
// → future-slot → package-window → slot-availability → apply → redirect.

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
vi.mock("@/lib/auth", () => ({ requireStudent: vi.fn(async () => ({ id: "s1" })) }));
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: vi.fn(async () => ["s1"]) }));

const state = {
  booking: null as Record<string, unknown> | null,
  eligibility: { ok: true } as { ok: boolean; reason?: string },
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

vi.mock("@/lib/cancellation/classify", () => ({
  canStudentRescheduleBooking: () => state.eligibility,
  scheduleChangeBudget: () => 3,
}));

vi.mock("@/lib/slots", () => ({
  generateSlots: () => (state.slotMatches ? [{ startUtc: new Date(FUTURE) }] : []),
}));

const applyReschedule = vi.fn(async () => state.outcome);
vi.mock("@/lib/cancellation/reschedule-handler", () => ({ applyReschedule }));

const { rescheduleBooking } = await import("@/app/actions/reschedule-booking");

const BK = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2027-01-01T15:00:00.000Z";

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
    teacherId: "t1",
    studentId: "s1",
    packageId: "pkg1",
    scheduledStart: new Date("2026-12-01T15:00:00Z"),
    status: "scheduled",
    rescheduleCount: 0,
    teacher: { timezone: "America/Mexico_City", bufferMin: 0, minAdvanceH: 1, maxAdvanceDays: 60 },
    package: { classDurationMin: 50, classesTotal: 10, scheduleChangesUsed: 0, expiresAt: null },
    ...over,
  };
}

async function run(f: FormData): Promise<{ error?: string } | { redirectTo: string }> {
  try {
    return (await rescheduleBooking(undefined, f)) ?? {};
  } catch (err) {
    if (err instanceof RedirectError) return { redirectTo: err.url };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.booking = booking();
  state.eligibility = { ok: true };
  state.slotMatches = true;
  state.outcome = { code: "ok", newBookingId: "new1" };
});

describe("rescheduleBooking", () => {
  it("rejects invalid input", async () => {
    expect(await run(fd({ bookingId: "x" }))).toHaveProperty("error");
  });

  it("404s a booking the student doesn't own", async () => {
    state.booking = null;
    expect(await run(fd())).toHaveProperty("error");
  });

  it("surfaces an eligibility rejection (e.g. lt24h)", async () => {
    state.eligibility = { ok: false, reason: "lt24h" };
    const res = await run(fd());
    expect(res).toHaveProperty("error");
    expect(applyReschedule).not.toHaveBeenCalled();
  });

  it("refuses a slot in the past", async () => {
    expect(await run(fd({ startUtc: "2020-01-01T00:00:00.000Z" }))).toHaveProperty("error");
  });

  it("refuses a slot beyond the package expiry", async () => {
    state.booking = booking({
      package: {
        classDurationMin: 50,
        classesTotal: 10,
        scheduleChangesUsed: 0,
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      },
    });
    expect(await run(fd())).toHaveProperty("error");
  });

  it("errors when the chosen slot is no longer available", async () => {
    state.slotMatches = false;
    expect(await run(fd())).toHaveProperty("error");
    expect(applyReschedule).not.toHaveBeenCalled();
  });

  it("maps a slot-conflict outcome to a friendly error", async () => {
    state.outcome = { code: "slot-conflict" };
    expect(await run(fd())).toHaveProperty("error");
  });

  it("redirects to the new booking on success", async () => {
    expect(await run(fd())).toEqual({ redirectTo: "/my-classes/new1" });
  });
});
