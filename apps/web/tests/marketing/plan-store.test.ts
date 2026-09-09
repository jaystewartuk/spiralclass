import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Persisting the week. The pure planner is tested in @spiralclass/shared; this
// covers the half that touches the database — gathering the signals it ranks
// by, and the two rules that make a plan safe to regenerate: it is idempotent,
// and it never rewrites what the teacher already did.

const planUpsert = vi.fn();
const planFindUnique = vi.fn();
const activityCount = vi.fn();
const activityDeleteMany = vi.fn();
const activityFindMany = vi.fn();
const activityFindFirst = vi.fn();
const activityGroupBy = vi.fn();
const communityFindMany = vi.fn();
const communityFindFirst = vi.fn();
const eventGroupBy = vi.fn();
const bookingFindMany = vi.fn();
const bookingCount = vi.fn();
const studentLinkFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingPlan: { upsert: planUpsert, findUnique: planFindUnique },
    marketingActivity: {
      count: activityCount,
      deleteMany: activityDeleteMany,
      findMany: activityFindMany,
      findFirst: activityFindFirst,
      groupBy: activityGroupBy,
      create: vi.fn(async () => ({ id: "a1" })),
    },
    teacherShareGroup: { findMany: communityFindMany, findFirst: communityFindFirst },
    acquisitionEvent: { groupBy: eventGroupBy },
    booking: { findMany: bookingFindMany, count: bookingCount },
    teacherStudent: { findFirst: studentLinkFindFirst },
  },
}));

const buildTeacherContext = vi.fn();
vi.mock("@/lib/marketing/profile", () => ({ buildTeacherContext }));

const createActivity = vi.fn(async (_input: Record<string, unknown>) => "a1");
const listActivities = vi.fn(async () => []);
vi.mock("@/lib/marketing/activities", () => ({ createActivity, listActivities }));

const { ensureWeeklyPlan, gatherPlannerSignals, referralCandidatesFor, regenerateWeeklyPlan } =
  await import("@/lib/marketing/plan");
type TeacherContext = Parameters<typeof gatherPlannerSignals>[1];

const NOW = new Date("2026-08-19T10:00:00Z");

const CONTEXT = {
  teacherId: "t1",
  capabilities: {
    hasTestimonial: true,
    hasPackage: true,
    hasStudents: true,
    hasAvailability: true,
    hasPhoto: true,
  },
  profile: { weeklyMinutes: 60 },
} as unknown as TeacherContext;

beforeEach(() => {
  vi.clearAllMocks();
  buildTeacherContext.mockResolvedValue(CONTEXT);
  planUpsert.mockResolvedValue({ id: "p1", weekStart: new Date("2026-08-17"), weeklyMinutes: 60 });
  activityCount.mockResolvedValue(0);
  activityFindMany.mockResolvedValue([]);
  activityFindFirst.mockResolvedValue(null);
  activityGroupBy.mockResolvedValue([]);
  communityFindMany.mockResolvedValue([]);
  eventGroupBy.mockResolvedValue([]);
  bookingFindMany.mockResolvedValue([]);
  bookingCount.mockResolvedValue(1);
});

describe("gatherPlannerSignals", () => {
  it("folds the acquisition ledger into per-community results", async () => {
    communityFindMany.mockResolvedValue([
      { id: "c1", name: "Oaxaca Expats", platform: "facebook_group", promoPolicy: "open" },
    ]);
    eventGroupBy.mockResolvedValue([
      { communityId: "c1", kind: "visit", _count: { _all: 40 } },
      { communityId: "c1", kind: "enquiry", _count: { _all: 6 } },
      { communityId: "c1", kind: "purchase", _count: { _all: 2 } },
    ]);
    activityGroupBy.mockResolvedValue([
      { communityId: "c1", _max: { completedAt: new Date("2026-08-01") } },
    ]);

    const signals = await gatherPlannerSignals("t1", CONTEXT, NOW);
    expect(signals.communities[0]).toMatchObject({
      id: "c1",
      visits: 40,
      enquiries: 6,
      students: 2,
      lastActivityAt: new Date("2026-08-01"),
    });
  });

  it("reads only live communities — an archived one is not planned into", async () => {
    await gatherPlannerSignals("t1", CONTEXT, NOW);
    expect(communityFindMany.mock.calls[0][0]).toMatchObject({
      where: { teacherId: "t1", archivedAt: null },
    });
  });

  it("degrades an unknown platform or policy to the safe value", async () => {
    communityFindMany.mockResolvedValue([
      { id: "c1", name: "X", platform: "myspace", promoPolicy: "definitely_fine" },
    ]);
    const signals = await gatherPlannerSignals("t1", CONTEXT, NOW);
    // A value written by a newer deploy must never be read as permission.
    expect(signals.communities[0].platform).toBe("other");
    expect(signals.communities[0].promoPolicy).toBe("unknown");
  });

  it("carries the teacher's stated time budget through to the planner", async () => {
    const signals = await gatherPlannerSignals(
      "t1",
      { ...CONTEXT, profile: { weeklyMinutes: 120 } } as unknown as TeacherContext,
      NOW,
    );
    expect(signals.weeklyMinutes).toBe(120);
  });
});

describe("referralCandidatesFor", () => {
  it("proposes a student whose first lesson just completed", async () => {
    bookingFindMany.mockResolvedValue([{ studentId: "s1", student: { name: "Mira" } }]);
    bookingCount.mockResolvedValue(1);
    const out = await referralCandidatesFor("t1");
    expect(out).toEqual([{ studentId: "s1", studentName: "Mira", trigger: "first_lesson" }]);
  });

  it("labels a returning student's moment as a renewal, not a first lesson", async () => {
    bookingFindMany.mockResolvedValue([{ studentId: "s1", student: { name: "Mira" } }]);
    bookingCount.mockResolvedValue(9);
    expect((await referralCandidatesFor("t1"))[0].trigger).toBe("renewal");
  });

  it("never re-asks a student who was asked in the last 90 days", async () => {
    // An ask is a one-off, not a drip: repeating it is what makes a referral
    // programme read as spam to the person receiving it.
    bookingFindMany.mockResolvedValue([{ studentId: "s1", student: { name: "Mira" } }]);
    activityFindFirst.mockResolvedValue({ id: "old-ask" });
    expect(await referralCandidatesFor("t1")).toEqual([]);
  });

  it("de-duplicates a student with several completed lessons", async () => {
    bookingFindMany.mockResolvedValue([
      { studentId: "s1", student: { name: "Mira" } },
      { studentId: "s1", student: { name: "Mira" } },
    ]);
    expect(await referralCandidatesFor("t1")).toHaveLength(1);
  });

  it("caps how many it will propose", async () => {
    bookingFindMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ studentId: `s${i}`, student: { name: `S${i}` } })),
    );
    expect((await referralCandidatesFor("t1", 2)).length).toBe(2);
  });
});

describe("ensureWeeklyPlan", () => {
  it("returns null when the teacher's account can't be resolved", async () => {
    buildTeacherContext.mockResolvedValue(null);
    expect(await ensureWeeklyPlan({ teacherId: "t1", now: NOW })).toBeNull();
  });

  it("upserts on (teacher, Monday) so calling it on every page load is free", async () => {
    await ensureWeeklyPlan({ teacherId: "t1", now: NOW });
    expect(planUpsert.mock.calls[0][0].where).toEqual({
      teacherId_weekStart: { teacherId: "t1", weekStart: new Date("2026-08-17T00:00:00.000Z") },
    });
    expect(planUpsert.mock.calls[0][0].update).toEqual({});
  });

  it("creates the week's activities when the plan is empty", async () => {
    communityFindMany.mockResolvedValue([
      { id: "c1", name: "Oaxaca Expats", platform: "facebook_group", promoPolicy: "open" },
    ]);
    await ensureWeeklyPlan({ teacherId: "t1", now: NOW });
    expect(createActivity).toHaveBeenCalled();
    expect(createActivity.mock.calls[0][0]).toMatchObject({ teacherId: "t1", planId: "p1" });
  });

  it("adds nothing when the plan already has activities", async () => {
    activityCount.mockResolvedValue(5);
    await ensureWeeklyPlan({ teacherId: "t1", now: NOW });
    expect(createActivity).not.toHaveBeenCalled();
  });

  it("plans nothing at all when there are no communities", async () => {
    await ensureWeeklyPlan({ teacherId: "t1", now: NOW });
    expect(createActivity).not.toHaveBeenCalled();
  });
});

describe("regenerateWeeklyPlan", () => {
  it("discards only what she has not acted on", async () => {
    planFindUnique.mockResolvedValue({ id: "p1" });
    await regenerateWeeklyPlan({ teacherId: "t1", now: NOW });
    expect(activityDeleteMany.mock.calls[0][0]).toEqual({
      where: { planId: "p1", status: { in: ["planned", "skipped"] } },
    });
  });

  it("is safe on a week that has no plan yet", async () => {
    planFindUnique.mockResolvedValue(null);
    await regenerateWeeklyPlan({ teacherId: "t1", now: NOW });
    expect(activityDeleteMany).not.toHaveBeenCalled();
    expect(planUpsert).toHaveBeenCalled();
  });
});
