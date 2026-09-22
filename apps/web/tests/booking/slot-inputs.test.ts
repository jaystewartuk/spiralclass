import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/calendar/google/busy", () => ({
  loadGoogleBusyBlocks: vi.fn(async () => []),
}));

const { loadSlotInputs } = await import("@/lib/booking/slot-inputs");
const { loadGoogleBusyBlocks } = await import("@/lib/calendar/google/busy");

const TEACHER_ID = "t1";
const WINDOW_START = new Date("2026-07-10T00:00:00.000Z");
const WINDOW_END = new Date("2026-07-17T00:00:00.000Z");

function makePrisma(
  overrides: {
    rules?: Array<{ weekday: number; startTime: string; endTime: string }>;
    blocked?: Array<{ startsAt: Date; endsAt: Date }>;
    bookings?: Array<{ scheduledStart: Date; scheduledEnd: Date }>;
  } = {},
) {
  const calls: { blockedDateWhere?: unknown; bookingWhere?: unknown } = {};
  const prisma = {
    availabilityRule: {
      findMany: vi.fn(async () => overrides.rules ?? []),
    },
    blockedDate: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        calls.blockedDateWhere = args.where;
        return overrides.blocked ?? [];
      }),
    },
    googleBusyInterval: {},
    booking: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        calls.bookingWhere = args.where;
        return overrides.bookings ?? [];
      }),
    },
  };
  return { prisma: prisma as never, calls, raw: prisma };
}

beforeEach(() => {
  vi.mocked(loadGoogleBusyBlocks).mockClear();
  vi.mocked(loadGoogleBusyBlocks).mockResolvedValue([]);
});

describe("loadSlotInputs", () => {
  it("maps availability rules straight through", async () => {
    const { prisma } = makePrisma({
      rules: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
    });

    const result = await loadSlotInputs(prisma, TEACHER_ID, WINDOW_START, WINDOW_END);

    expect(result.availabilityRules).toEqual([
      { weekday: 1, startTime: "09:00", endTime: "17:00" },
    ]);
  });

  it("converts blocked dates and existing bookings to ISO strings", async () => {
    const blockedStart = new Date("2026-07-12T10:00:00.000Z");
    const blockedEnd = new Date("2026-07-12T11:00:00.000Z");
    const bookingStart = new Date("2026-07-13T14:00:00.000Z");
    const bookingEnd = new Date("2026-07-13T14:50:00.000Z");
    const { prisma } = makePrisma({
      blocked: [{ startsAt: blockedStart, endsAt: blockedEnd }],
      bookings: [{ scheduledStart: bookingStart, scheduledEnd: bookingEnd }],
    });

    const result = await loadSlotInputs(prisma, TEACHER_ID, WINDOW_START, WINDOW_END);

    expect(result.blockedDates).toEqual([
      { startsAt: blockedStart.toISOString(), endsAt: blockedEnd.toISOString() },
    ]);
    expect(result.existingBookings).toEqual([
      { scheduledStart: bookingStart.toISOString(), scheduledEnd: bookingEnd.toISOString() },
    ]);
  });

  it("merges Google busy blocks after DB blocked dates, in that order", async () => {
    const dbBlock = {
      startsAt: new Date("2026-07-11T00:00:00.000Z"),
      endsAt: new Date("2026-07-11T01:00:00.000Z"),
    };
    const googleBlock = {
      startsAt: new Date("2026-07-14T00:00:00.000Z"),
      endsAt: new Date("2026-07-14T01:00:00.000Z"),
    };
    vi.mocked(loadGoogleBusyBlocks).mockResolvedValue([googleBlock]);
    const { prisma } = makePrisma({ blocked: [dbBlock] });

    const result = await loadSlotInputs(prisma, TEACHER_ID, WINDOW_START, WINDOW_END);

    expect(result.blockedDates).toEqual([
      { startsAt: dbBlock.startsAt.toISOString(), endsAt: dbBlock.endsAt.toISOString() },
      { startsAt: googleBlock.startsAt.toISOString(), endsAt: googleBlock.endsAt.toISOString() },
    ]);
  });

  it("pads the query window by 24h before and 48h after the requested window", async () => {
    const { prisma, calls } = makePrisma();

    await loadSlotInputs(prisma, TEACHER_ID, WINDOW_START, WINDOW_END);

    const expectedLo = new Date(WINDOW_START.getTime() - 24 * 3600_000);
    const expectedHi = new Date(WINDOW_END.getTime() + 48 * 3600_000);

    expect(calls.blockedDateWhere).toEqual({
      teacherId: TEACHER_ID,
      endsAt: { gt: expectedLo },
      startsAt: { lt: expectedHi },
    });
    expect(calls.bookingWhere).toEqual({
      teacherId: TEACHER_ID,
      status: "scheduled",
      scheduledStart: { gte: expectedLo, lt: expectedHi },
    });
  });

  it("scopes every query to the given teacherId", async () => {
    const { prisma, raw } = makePrisma();

    await loadSlotInputs(prisma, "teacher-42", WINDOW_START, WINDOW_END);

    expect(raw.availabilityRule.findMany).toHaveBeenCalledWith({
      where: { teacherId: "teacher-42" },
    });
    expect(loadGoogleBusyBlocks).toHaveBeenCalledWith("teacher-42", prisma);
  });

  it("only includes bookings with status scheduled (filtered at the query, not in code)", async () => {
    const { prisma, calls } = makePrisma();

    await loadSlotInputs(prisma, TEACHER_ID, WINDOW_START, WINDOW_END);

    expect((calls.bookingWhere as { status: string }).status).toBe("scheduled");
  });

  it("returns empty arrays when the teacher has no rules, blocks, or bookings", async () => {
    const { prisma } = makePrisma();

    const result = await loadSlotInputs(prisma, TEACHER_ID, WINDOW_START, WINDOW_END);

    expect(result).toEqual({
      availabilityRules: [],
      blockedDates: [],
      existingBookings: [],
    });
  });
});
