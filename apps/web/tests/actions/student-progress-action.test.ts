import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher opts a student in/out of seeing their own learning profile (Phase F).
// Web wrapper over setShareProgressFor: pins the Pro-gate (non-Pro → upgrade
// nudge, no write), the not-found vs generic error mapping, and the success
// revalidate.

const state = {
  gate: { ok: true as boolean, limit: undefined as unknown },
  share: { ok: true as boolean, reason: undefined as string | undefined },
};

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const gateProFeature = vi.fn(async () => state.gate);
const upgradeNudge = vi.fn(() => "Upgrade to Pro");
vi.mock("@/lib/subscriptions/enforce", () => ({ gateProFeature, upgradeNudge }));

const setShareProgressFor = vi.fn(async () => state.share);
vi.mock("@/lib/lesson-notes/student-prefs", () => ({ setShareProgressFor }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { setShareProgress } = await import("@/app/actions/student-progress");

beforeEach(() => {
  vi.clearAllMocks();
  state.gate = { ok: true, limit: undefined };
  state.share = { ok: true, reason: undefined };
});

describe("setShareProgress", () => {
  it("returns the upgrade nudge and never writes when not Pro", async () => {
    state.gate = { ok: false, limit: { feature: "lesson_notes" } };
    const res = await setShareProgress("s1", true);
    expect(res).toEqual({ error: "Upgrade to Pro" });
    expect(setShareProgressFor).not.toHaveBeenCalled();
  });

  it("maps a not-found result to a student-not-found message", async () => {
    state.share = { ok: false, reason: "not-found" };
    const res = await setShareProgress("s1", true);
    expect(res).toHaveProperty("error");
    expect(res.ok).toBeUndefined();
  });

  it("maps any other failure to a generic retry message", async () => {
    state.share = { ok: false, reason: "db-error" };
    const res = await setShareProgress("s1", true);
    expect(res).toHaveProperty("error");
  });

  it("shares progress and revalidates the student page on success", async () => {
    const res = await setShareProgress("s1", true);
    expect(res).toEqual({ ok: true });
    expect(setShareProgressFor).toHaveBeenCalledWith(expect.anything(), "t1", "s1", true);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/students/s1");
  });
});
