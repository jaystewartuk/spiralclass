import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The Monday nudge. The whole reason it replaced the Facebook-groups reminder
// is that it names the first action instead of saying "you should post" — so
// what it says, and who it says it to, is the contract worth pinning.

const ensureWeeklyPlan = vi.fn();
vi.mock("@/lib/marketing/plan", () => ({ ensureWeeklyPlan }));

// Avoid pulling the Inngest client (and its server-env validation) in via the
// transitive `./events` import — the handler takes `emit` through deps anyway.
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const { sendWeeklyPlanNudges } = await import("@/lib/notifications/weekly-plan-nudge");

const NOW = new Date("2026-08-17T16:00:00Z");

function prisma(over: Record<string, unknown> = {}) {
  const base = {
    teacherShareGroup: { groupBy: vi.fn(async () => [{ teacherId: "t1", _count: { _all: 2 } }]) },
    notification: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: "n1" })) },
    teacher: { findMany: vi.fn(async () => [{ id: "t1", locale: "es-MX" }]) },
  };
  return { ...base, ...over } as never;
}

const ACTIVITY = {
  id: "a1",
  kind: "tip",
  platform: "facebook_group",
  status: "planned",
  community: { id: "c1", name: "Oaxaca Expats", url: null, platform: "facebook_group" },
  student: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  ensureWeeklyPlan.mockResolvedValue({
    id: "p1",
    weekStart: new Date("2026-08-17"),
    weeklyMinutes: 60,
    activities: [ACTIVITY, { ...ACTIVITY, id: "a2" }],
  });
});

describe("sendWeeklyPlanNudges", () => {
  it("does nothing at all when no teacher has saved a community", async () => {
    const db = prisma({ teacherShareGroup: { groupBy: vi.fn(async () => []) } });
    const emit = vi.fn();
    expect(await sendWeeklyPlanNudges({ prisma: db, emit, now: NOW })).toEqual({
      ok: true,
      sent: 0,
      skipped: 0,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("builds the plan BEFORE announcing it, so the link lands on real content", async () => {
    const emit = vi.fn();
    await sendWeeklyPlanNudges({ prisma: prisma(), emit, now: NOW });
    expect(ensureWeeklyPlan).toHaveBeenCalledWith({ teacherId: "t1", now: NOW });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("names the first action rather than nagging", async () => {
    const insert = vi.fn(async (_args: { data: { metadata: Record<string, unknown> } }) => ({
      id: "n1",
    }));
    const db = prisma({ notification: { findMany: vi.fn(async () => []), create: insert } });
    await sendWeeklyPlanNudges({ prisma: db, emit: vi.fn(), now: NOW });
    const metadata = insert.mock.calls[0][0].data.metadata as Record<string, unknown>;
    expect(metadata.actionCount).toBe(2);
    expect(metadata.firstAction).toContain("Oaxaca Expats");
    expect(metadata.minutes).toBe(24);
  });

  it("skips a teacher already nudged inside the cadence window", async () => {
    const db = prisma({
      notification: { findMany: vi.fn(async () => [{ teacherId: "t1" }]), create: vi.fn() },
    });
    const emit = vi.fn();
    const out = await sendWeeklyPlanNudges({ prisma: db, emit, now: NOW });
    expect(out).toMatchObject({ sent: 0, skipped: 1 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("skips a teacher whose plan came back empty — nothing to announce", async () => {
    ensureWeeklyPlan.mockResolvedValue({
      id: "p1",
      weekStart: new Date(),
      weeklyMinutes: 60,
      activities: [],
    });
    const out = await sendWeeklyPlanNudges({ prisma: prisma(), emit: vi.fn(), now: NOW });
    expect(out).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("counts only work still outstanding", async () => {
    ensureWeeklyPlan.mockResolvedValue({
      id: "p1",
      weekStart: new Date(),
      weeklyMinutes: 60,
      activities: [ACTIVITY, { ...ACTIVITY, id: "a2", status: "done" }],
    });
    const insert = vi.fn(async (_args: { data: { metadata: Record<string, unknown> } }) => ({
      id: "n1",
    }));
    const db = prisma({ notification: { findMany: vi.fn(async () => []), create: insert } });
    await sendWeeklyPlanNudges({ prisma: db, emit: vi.fn(), now: NOW });
    expect((insert.mock.calls[0][0].data.metadata as { actionCount: number }).actionCount).toBe(1);
  });

  it("never sends growth mail to a moderated teacher", async () => {
    const db = prisma({ teacher: { findMany: vi.fn(async () => []) } });
    const emit = vi.fn();
    await sendWeeklyPlanNudges({ prisma: db, emit, now: NOW });
    expect(emit).not.toHaveBeenCalled();
  });

  it("reads only live communities for eligibility", async () => {
    const groupBy = vi.fn(async (_args: { where: { archivedAt: null } }) => [
      { teacherId: "t1", _count: { _all: 1 } },
    ]);
    await sendWeeklyPlanNudges({
      prisma: prisma({ teacherShareGroup: { groupBy } }),
      emit: vi.fn(),
      now: NOW,
    });
    expect(groupBy.mock.calls[0][0]).toMatchObject({ where: { archivedAt: null } });
  });

  it("bounds how many teachers one cron tick fans out to", async () => {
    const groupBy = vi.fn(async () =>
      Array.from({ length: 50 }, (_, i) => ({ teacherId: `t${i}`, _count: { _all: 1 } })),
    );
    const teacherFindMany = vi.fn(
      async (_args: { where: { id: { in: string[] } } }): Promise<unknown[]> => [],
    );
    await sendWeeklyPlanNudges({
      prisma: prisma({ teacherShareGroup: { groupBy }, teacher: { findMany: teacherFindMany } }),
      emit: vi.fn(),
      now: NOW,
      limit: 10,
    });
    expect((teacherFindMany.mock.calls[0][0].where.id.in as string[]).length).toBe(10);
  });
});
