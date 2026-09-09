import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The results screen's data layer. Its one job is to be arithmetically
// consistent: the three breakdowns and the headline must add up to the same
// events, because a teacher deciding where to spend her week reads them
// together.

const eventFindMany = vi.fn();
const eventGroupBy = vi.fn();
const communityFindMany = vi.fn();
const activityFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    acquisitionEvent: { findMany: eventFindMany, groupBy: eventGroupBy },
    teacherShareGroup: { findMany: communityFindMany },
    marketingActivity: { findMany: activityFindMany },
  },
}));

const { acquisitionHeadline, acquisitionReport } = await import("@/lib/marketing/analytics");

function ev(over: Record<string, unknown> = {}) {
  return {
    kind: "visit",
    source: null,
    communityId: null,
    activityId: null,
    viaReferral: false,
    amountMinorUnits: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  communityFindMany.mockResolvedValue([]);
  activityFindMany.mockResolvedValue([]);
  eventFindMany.mockResolvedValue([]);
  eventGroupBy.mockResolvedValue([]);
});

describe("acquisitionReport", () => {
  it("reports an empty, honest report for a teacher with no traffic", async () => {
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.overall.visits).toBe(0);
    expect(r.channels).toEqual([]);
    expect(r.observations[0].code).toBe("no_data");
  });

  it("bucketed totals reconcile with the headline totals", async () => {
    eventFindMany.mockResolvedValue([
      ev({ source: "facebook" }),
      ev({ source: "facebook" }),
      ev({ kind: "enquiry", source: "facebook" }),
      ev({ kind: "booking", source: "facebook" }),
      ev({ kind: "purchase", source: "facebook", amountMinorUnits: 250000 }),
      ev({ source: "reddit" }),
    ]);
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.overall).toMatchObject({
      visits: 3,
      enquiries: 1,
      bookings: 1,
      students: 1,
      revenueMinorUnits: 250000,
    });
    const summed = r.channels.reduce((n, c) => n + c.visits, 0);
    expect(summed).toBe(r.overall.visits);
  });

  it("labels community rows with the community's real name", async () => {
    communityFindMany.mockResolvedValue([{ id: "c1", name: "Oaxaca Expats", archivedAt: null }]);
    eventFindMany.mockResolvedValue([ev({ communityId: "c1", source: "facebook" })]);
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.communities[0]).toMatchObject({ key: "c1", label: "Oaxaca Expats", visits: 1 });
  });

  it("breaks content down by the kind of the activity that produced the visit", async () => {
    activityFindMany.mockResolvedValue([{ id: "a1", kind: "tip" }]);
    eventFindMany.mockResolvedValue([ev({ activityId: "a1" })]);
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.content[0]).toMatchObject({ key: "tip", label: "A useful tip", visits: 1 });
  });

  it("lists a saved community with no traffic as untried, not as a zero row", async () => {
    // "You haven't tried this yet" is an action; a row of zeroes is noise.
    communityFindMany.mockResolvedValue([{ id: "c1", name: "r/Spanish", archivedAt: null }]);
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.untriedCommunityLabels).toEqual(["r/Spanish"]);
    expect(r.communities).toEqual([]);
  });

  it("does not offer an archived community as something to try", async () => {
    communityFindMany.mockResolvedValue([
      { id: "c1", name: "Retired group", archivedAt: new Date() },
    ]);
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.untriedCommunityLabels).toEqual([]);
  });

  it("ranks rows by students, then enquiries, then visits", async () => {
    eventFindMany.mockResolvedValue([
      ev({ source: "reddit" }),
      ev({ source: "reddit" }),
      ev({ source: "reddit" }),
      ev({ kind: "purchase", source: "facebook", amountMinorUnits: 1 }),
    ]);
    const r = await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(r.channels[0].key).toBe("facebook");
  });

  it("defaults to a 90-day window and honours a 30-day one", async () => {
    await acquisitionReport({ teacherId: "t1", locale: "en" });
    const ninety = eventFindMany.mock.calls[0][0].where.occurredAt.gte as Date;
    vi.clearAllMocks();
    eventFindMany.mockResolvedValue([]);
    communityFindMany.mockResolvedValue([]);
    activityFindMany.mockResolvedValue([]);
    await acquisitionReport({ teacherId: "t1", windowDays: 30, locale: "en" });
    const thirty = eventFindMany.mock.calls[0][0].where.occurredAt.gte as Date;
    expect(thirty.getTime()).toBeGreaterThan(ninety.getTime());
  });

  it("scopes every read to the one teacher", async () => {
    await acquisitionReport({ teacherId: "t1", locale: "en" });
    expect(eventFindMany.mock.calls[0][0].where.teacherId).toBe("t1");
    expect(communityFindMany.mock.calls[0][0].where.teacherId).toBe("t1");
    expect(activityFindMany.mock.calls[0][0].where.teacherId).toBe("t1");
  });
});

describe("acquisitionHeadline", () => {
  it("sums revenue only from settled purchases", async () => {
    eventGroupBy.mockResolvedValue([
      { kind: "visit", _count: { _all: 40 }, _sum: { amountMinorUnits: null } },
      { kind: "enquiry", _count: { _all: 6 }, _sum: { amountMinorUnits: null } },
      { kind: "booking", _count: { _all: 3 }, _sum: { amountMinorUnits: null } },
      { kind: "purchase", _count: { _all: 2 }, _sum: { amountMinorUnits: 500000 } },
    ]);
    expect(await acquisitionHeadline("t1", 30)).toEqual({
      visits: 40,
      enquiries: 6,
      bookings: 3,
      students: 2,
      revenueMinorUnits: 500000,
    });
  });

  it("returns zeroes rather than nulls when nothing has happened", async () => {
    expect(await acquisitionHeadline("t1")).toEqual({
      visits: 0,
      enquiries: 0,
      bookings: 0,
      students: 0,
      revenueMinorUnits: 0,
    });
  });
});
