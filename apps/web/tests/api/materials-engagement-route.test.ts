import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/materials/[id]/opened + /completed — cookie-authed web triggers
// for material_opened/material_completed. Auth/plumbing only; property
// shaping is covered by tests/library/material-engagement.test.ts.

const getAuthUser = vi.fn(async () => null as { id: string } | null);
vi.mock("@/lib/auth", () => ({ getAuthUser: () => getAuthUser() }));

const studentFindFirst = vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(
  async () => null,
);
vi.mock("@/lib/prisma", () => ({
  prisma: { student: { findFirst: (...a: unknown[]) => studentFindFirst(...a) } },
}));

vi.mock("@/lib/analytics/posthog", () => ({ flushAnalytics: vi.fn(async () => {}) }));

const trackMaterialEngagement = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/lib/library/engagement", () => ({
  trackMaterialEngagement: (...a: unknown[]) => trackMaterialEngagement(...a),
}));

const { POST: postOpened } = await import("@/app/api/materials/[id]/opened/route");
const { POST: postCompleted } = await import("@/app/api/materials/[id]/completed/route");

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function req(body?: unknown) {
  return new Request("https://test.local/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/materials/[id]/opened", () => {
  it("401s with no session", async () => {
    getAuthUser.mockResolvedValue(null);
    const res = await postOpened(req(), ctx("m1"));
    expect(res.status).toBe(401);
    expect(trackMaterialEngagement).not.toHaveBeenCalled();
  });

  it("401s when the session isn't linked to a student row", async () => {
    getAuthUser.mockResolvedValue({ id: "u1" });
    studentFindFirst.mockResolvedValue(null);
    const res = await postOpened(req(), ctx("m1"));
    expect(res.status).toBe(401);
  });

  it("tracks opened for the authenticated student", async () => {
    getAuthUser.mockResolvedValue({ id: "u1" });
    studentFindFirst.mockResolvedValue({ id: "s1" });
    const res = await postOpened(req(), ctx("m1"));
    expect(res.status).toBe(200);
    expect(trackMaterialEngagement).toHaveBeenCalledWith("s1", "m1", "opened", "web", undefined);
  });
});

describe("POST /api/materials/[id]/completed", () => {
  it("forwards durationSeconds from the body", async () => {
    getAuthUser.mockResolvedValue({ id: "u1" });
    studentFindFirst.mockResolvedValue({ id: "s1" });
    const res = await postCompleted(req({ durationSeconds: 90 }), ctx("m1"));
    expect(res.status).toBe(200);
    expect(trackMaterialEngagement).toHaveBeenCalledWith("s1", "m1", "completed", "web", 90);
  });

  it("defaults durationSeconds to undefined when the body is empty", async () => {
    getAuthUser.mockResolvedValue({ id: "u1" });
    studentFindFirst.mockResolvedValue({ id: "s1" });
    const res = await postCompleted(req({}), ctx("m1"));
    expect(res.status).toBe(200);
    expect(trackMaterialEngagement).toHaveBeenCalledWith("s1", "m1", "completed", "web", undefined);
  });
});
