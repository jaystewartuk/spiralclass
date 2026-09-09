import { describe, expect, it } from "vitest";
import {
  actionsForBudget,
  buildWeeklyPlan,
  estimatedMinutesFor,
  MAX_ACTIONS_PER_WEEK,
  MIN_ACTIONS_PER_WEEK,
  MINUTES_PER_ACTION,
  planProgress,
  planReasonText,
  REFERRAL_ASK_MINUTES,
  weekStartOf,
  type PlanActivityStatus,
  type PlannerCommunity,
  type PlannerSignals,
} from "./planner";
import { CONTENT_KIND_SPECS, type MarketingContentKind } from "./content-kinds";

const NOW = new Date("2026-08-19T10:00:00Z"); // a Wednesday

const CAPABLE = {
  hasTestimonial: true,
  hasPackage: true,
  hasStudents: true,
  hasAvailability: true,
  hasPhoto: true,
};

function community(over: Partial<PlannerCommunity> = {}): PlannerCommunity {
  return {
    id: "c1",
    name: "Oaxaca Expats",
    platform: "facebook_group",
    promoPolicy: "open",
    lastActivityAt: null,
    visits: 0,
    enquiries: 0,
    students: 0,
    ...over,
  };
}

function signals(over: Partial<PlannerSignals> = {}): PlannerSignals {
  return {
    communities: [community()],
    capabilities: CAPABLE,
    referralCandidates: [],
    recentActivities: [],
    weeklyMinutes: 60,
    now: NOW,
    ...over,
  };
}

describe("weekStartOf", () => {
  it("snaps to Monday 00:00 UTC", () => {
    expect(weekStartOf(NOW).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });
  it("treats Sunday as belonging to the week that started six days earlier", () => {
    expect(weekStartOf(new Date("2026-08-23T23:00:00Z")).toISOString()).toBe(
      "2026-08-17T00:00:00.000Z",
    );
  });
  it("is idempotent", () => {
    const w = weekStartOf(NOW);
    expect(weekStartOf(w).toISOString()).toBe(w.toISOString());
  });
});

describe("actionsForBudget", () => {
  it("sizes the week to the teacher's stated time, within bounds", () => {
    expect(actionsForBudget(60)).toBe(5);
    expect(actionsForBudget(15)).toBe(MIN_ACTIONS_PER_WEEK);
    expect(actionsForBudget(600)).toBe(MAX_ACTIONS_PER_WEEK);
  });
});

describe("buildWeeklyPlan — platform safety", () => {
  it("never schedules a promotional action into a prohibited community", () => {
    const plan = buildWeeklyPlan(
      signals({
        communities: [
          community({ id: "r1", name: "r/Spanish", platform: "reddit", promoPolicy: "prohibited" }),
        ],
      }),
    );
    expect(plan.actions.length).toBeGreaterThan(0);
    for (const a of plan.actions) {
      expect(CONTENT_KIND_SPECS[a.kind].promotional).toBe(false);
    }
  });

  it("never schedules a promotional action where the rules are unconfirmed", () => {
    const plan = buildWeeklyPlan(signals({ communities: [community({ promoPolicy: "unknown" })] }));
    for (const a of plan.actions) {
      expect(CONTENT_KIND_SPECS[a.kind].promotional).toBe(false);
    }
  });

  it("rations promotion even where it IS allowed — at most one per three posts", () => {
    const plan = buildWeeklyPlan(
      signals({
        weeklyMinutes: 120,
        communities: [
          community({ id: "a", name: "A" }),
          community({ id: "b", name: "B" }),
          community({ id: "c", name: "C" }),
          community({ id: "d", name: "D" }),
        ],
      }),
    );
    const posts = plan.actions.filter((a) => a.communityId);
    const promos = posts.filter((a) => CONTENT_KIND_SPECS[a.kind].promotional);
    expect(promos.length).toBeLessThanOrEqual(Math.ceil(posts.length / 3));
  });
});

describe("buildWeeklyPlan — what it schedules", () => {
  it("returns nothing to post when the teacher has no communities", () => {
    const plan = buildWeeklyPlan(signals({ communities: [] }));
    expect(plan.actions).toEqual([]);
  });

  it("leads with a referral ask when there is a real moment for one", () => {
    const plan = buildWeeklyPlan(
      signals({
        referralCandidates: [{ studentId: "s1", studentName: "Mira", trigger: "first_lesson" }],
      }),
    );
    expect(plan.actions[0].kind).toBe("referral_ask");
    expect(plan.actions[0].studentId).toBe("s1");
    expect(plan.actions[0].reason).toMatchObject({ code: "referral_moment", student: "Mira" });
  });

  it("does not schedule a referral ask for a teacher with no students", () => {
    const plan = buildWeeklyPlan(
      signals({
        capabilities: { ...CAPABLE, hasStudents: false },
        referralCandidates: [{ studentId: "s1", studentName: "Mira", trigger: "first_lesson" }],
      }),
    );
    expect(plan.actions.every((a) => a.kind !== "referral_ask")).toBe(true);
  });

  it("puts the community that actually produced students first", () => {
    const plan = buildWeeklyPlan(
      signals({
        communities: [
          community({ id: "cold", name: "Cold", visits: 2 }),
          community({ id: "hot", name: "Hot", visits: 40, enquiries: 6, students: 2 }),
        ],
      }),
    );
    expect(plan.actions[0].communityId).toBe("hot");
    expect(plan.actions[0].reason).toMatchObject({ code: "best_community", students: 2 });
  });

  it("still gives an untried community a turn rather than starving it", () => {
    const plan = buildWeeklyPlan(
      signals({
        communities: [
          community({
            id: "hot",
            name: "Hot",
            visits: 40,
            enquiries: 6,
            students: 2,
            lastActivityAt: NOW,
          }),
          community({ id: "new", name: "New" }),
        ],
      }),
    );
    expect(plan.actions.map((a) => a.communityId)).toContain("new");
  });

  it("respects the per-community cooldown", () => {
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const plan = buildWeeklyPlan(
      signals({
        communities: [
          community({ id: "fresh", name: "Fresh", lastActivityAt: yesterday }),
          community({ id: "stale", name: "Stale", lastActivityAt: null }),
        ],
      }),
    );
    // "fresh" was posted to yesterday, so the week's work goes to "stale".
    expect(plan.actions.every((a) => a.communityId === "stale")).toBe(true);
  });

  it("avoids repeating a content kind recently used in the same community", () => {
    const first = buildWeeklyPlan(signals());
    const usedKind = first.actions[0].kind;
    const second = buildWeeklyPlan(
      signals({
        recentActivities: [{ kind: usedKind, communityId: "c1", at: NOW }],
      }),
    );
    expect(second.actions[0].kind).not.toBe(usedKind);
  });

  it("is deterministic — the same signals always produce the same plan", () => {
    const a = buildWeeklyPlan(signals());
    const b = buildWeeklyPlan(signals());
    expect(b.actions.map((x) => `${x.kind}:${x.communityId}`)).toEqual(
      a.actions.map((x) => `${x.kind}:${x.communityId}`),
    );
  });

  it("numbers slots contiguously and reports the total time honestly", () => {
    const plan = buildWeeklyPlan(signals({ weeklyMinutes: 60 }));
    expect(plan.actions.map((a) => a.slot)).toEqual(plan.actions.map((_, i) => i + 1));
    expect(plan.totalMinutes).toBe(plan.actions.reduce((sum, a) => sum + a.estimatedMinutes, 0));
  });

  it("sizes the week to a small time budget", () => {
    const plan = buildWeeklyPlan(
      signals({
        weeklyMinutes: 20,
        communities: [community({ id: "a", name: "A" }), community({ id: "b", name: "B" })],
      }),
    );
    expect(plan.actions.length).toBeLessThanOrEqual(MIN_ACTIONS_PER_WEEK);
  });
});

describe("planReasonText", () => {
  it("renders every reason shape in every locale without leaking a placeholder", () => {
    const reasons = [
      { code: "best_community", community: "Oaxaca Expats", students: 2 },
      { code: "promising_community", community: "Oaxaca Expats", enquiries: 3 },
      { code: "quiet_community", community: "Oaxaca Expats", days: 12 },
      { code: "untried_community", community: "Oaxaca Expats" },
      { code: "educational_first", community: "Oaxaca Expats" },
      { code: "referral_moment", student: "Mira", trigger: "first_lesson" },
      { code: "no_communities" },
    ] as const;
    for (const locale of ["es-MX", "en", "fr"] as const) {
      for (const reason of reasons) {
        const text = planReasonText(reason, locale);
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toContain("{");
        expect(text).not.toContain("undefined");
      }
    }
  });

  it("uses the singular for one student", () => {
    expect(planReasonText({ code: "best_community", community: "X", students: 1 }, "en")).toContain(
      "1 student.",
    );
  });
});

describe("estimatedMinutesFor", () => {
  it("prices a referral ask below a community post", () => {
    expect(estimatedMinutesFor("referral_ask")).toBe(REFERRAL_ASK_MINUTES);
    expect(estimatedMinutesFor("tip")).toBe(MINUTES_PER_ACTION);
    expect(REFERRAL_ASK_MINUTES).toBeLessThan(MINUTES_PER_ACTION);
  });

  it("is what the planner itself stores on every action", () => {
    // The screen totals `estimatedMinutesFor`; the plan stores
    // `estimatedMinutes`. They are the same number or the week's total is a
    // fiction — which is exactly what the hardcoded 12 on the screen was.
    const plan = buildWeeklyPlan(
      signals({
        referralCandidates: [{ studentId: "s1", studentName: "Mira", trigger: "first_lesson" }],
      }),
    );
    expect(plan.actions.length).toBeGreaterThan(1);
    for (const action of plan.actions) {
      expect(action.estimatedMinutes).toBe(estimatedMinutesFor(action.kind));
    }
  });
});

describe("planProgress", () => {
  const item = (status: PlanActivityStatus, kind: MarketingContentKind = "tip") => ({
    kind,
    status,
  });

  it("counts done against done-plus-open", () => {
    const p = planProgress([item("done"), item("done"), item("planned"), item("ready")]);
    expect(p).toMatchObject({ total: 4, done: 2, remaining: 2, skipped: 0, complete: false });
    expect(p.fraction).toBe(0.5);
  });

  it("drops a skipped action from the denominator so the week can finish", () => {
    // The point: skipping is a decision, not an unfinished chore. Two done and
    // two skipped IS a finished week, and a meter stuck at 50% would say
    // otherwise.
    const p = planProgress([item("done"), item("done"), item("skipped"), item("skipped")]);
    expect(p).toMatchObject({ total: 2, done: 2, skipped: 2, remaining: 0, complete: true });
    expect(p.fraction).toBe(1);
  });

  it("adds up the minutes only the OPEN actions still cost", () => {
    const p = planProgress([
      item("done"),
      item("planned"),
      item("ready", "referral_ask"),
      item("skipped"),
    ]);
    expect(p.minutesLeft).toBe(MINUTES_PER_ACTION + REFERRAL_ASK_MINUTES);
  });

  it("is not complete when nothing was planned at all", () => {
    // An empty plan is a teacher with no communities, not a finished week —
    // the screen shows her how to start, not a congratulation.
    expect(planProgress([])).toMatchObject({ total: 0, complete: false, fraction: 0 });
  });
});
