import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/captions/config — what a participant's browser learns before it
// captions a class (D-185). "Off for this class" must come back as an answer
// (enabled: false) so a client stops quietly; only "not your class" is an
// error. The access check underneath is tested on its own in access.test.ts.

vi.mock("server-only", () => ({}));

const { ApiAuthError } = await import("@/lib/api/auth");

const state = {
  participant: { role: "teacher", teacher: { id: "t1" } } as unknown,
  access: { ok: true, session: { bookingId: "b1" }, callerId: "t1" } as unknown,
};
vi.mock("@/lib/api/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/auth")>()),
  requireApiCallParticipant: async () => {
    if (state.participant instanceof Error) throw state.participant;
    return state.participant;
  },
}));
const captionAccessFor = vi.fn(async (..._a: unknown[]) => state.access);
vi.mock("@/lib/captions/access", () => ({
  captionAccessFor: (...a: unknown[]) => captionAccessFor(...a),
}));

const { POST } = await import("@/app/api/captions/config/route");

async function call(body: unknown = { bookingId: "b1" }, headers: Record<string, string> = {}) {
  const res = await POST(
    new Request("https://test.local/api/captions/config", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.participant = { role: "teacher", teacher: { id: "t1" } };
  state.access = { ok: true, session: { bookingId: "b1" }, callerId: "t1" };
});

describe("POST /api/captions/config", () => {
  it("returns the caption session for a participant", async () => {
    expect(await call()).toEqual({
      status: 200,
      body: { ok: true, enabled: true, session: { bookingId: "b1" } },
    });
    expect(captionAccessFor).toHaveBeenCalledWith(state.participant, "b1");
  });

  it("answers enabled:false when captions are off, or not on the teacher's plan", async () => {
    for (const reason of ["disabled", "not-entitled"]) {
      state.access = { ok: false, reason };
      expect(await call()).toEqual({ status: 200, body: { ok: true, enabled: false } });
    }
  });

  it("answers 404 for a class the caller is not a party to", async () => {
    state.access = { ok: false, reason: "not-found" };
    expect((await call()).status).toBe(404);
  });

  it("refuses an unauthenticated caller before reading the body", async () => {
    state.participant = new ApiAuthError(401, "no-session");
    expect((await call({ nonsense: true })).status).toBe(401);
    expect(captionAccessFor).not.toHaveBeenCalled();
  });

  it("refuses a malformed body", async () => {
    expect((await call({ bookingId: "" })).status).toBe(400);
  });

  it("refuses a cross-origin request", async () => {
    expect((await call(undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect(captionAccessFor).not.toHaveBeenCalled();
  });
});
