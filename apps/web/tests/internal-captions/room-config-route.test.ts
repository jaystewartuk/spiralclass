import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/internal/captions/room-config — called by the self-hosted LiveKit
// captions Agent (packages/livekit-captions-agent) to resolve a room's
// booking, both directions' language pair, the Pro gate, and student consent.
// Auth is a shared secret, not a session — pins the dark-by-default auth gate
// plus the config-resolution outcomes. Deps mocked throughout.

type Config = {
  bookingId: string;
  teacherId: string;
  studentId: string;
  teacherDirection: { source: string; target: string };
  studentDirection: { source: string; target: string };
  studentCaptionsAllowed: boolean;
} | null;

const state = {
  authOk: true,
  enabled: true,
  bookingId: "b1" as string | null,
  config: {
    bookingId: "b1",
    teacherId: "t1",
    studentId: "s1",
    teacherDirection: { source: "es", target: "en" },
    studentDirection: { source: "en", target: "es" },
    studentCaptionsAllowed: true,
  } as Config,
  gateOk: true,
};

vi.mock("@/lib/captions/internal-auth", () => ({
  captionsAgentAuthOk: () => state.authOk,
}));
vi.mock("@/lib/captions/config", () => ({ liveCaptionsEnabled: () => state.enabled }));
vi.mock("@/lib/video/provider", () => ({
  bookingIdFromCallRoom: (room: string) =>
    state.bookingId ?? (room.startsWith("class-") ? room.slice(6) : null),
}));

const resolveClassCallRoomConfig = vi.fn<(...a: unknown[]) => Promise<Config>>(
  async () => state.config,
);
vi.mock("@/lib/captions/class-access", () => ({
  resolveClassCallRoomConfig: (...a: unknown[]) => resolveClassCallRoomConfig(...a),
}));

vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: async () => (state.gateOk ? { ok: true } : { ok: false, limit: "lesson_notes" }),
}));

const { POST } = await import("@/app/api/internal/captions/room-config/route");

function req(
  body: unknown,
  headers: Record<string, string> = { "x-captions-agent-secret": "s" },
): Request {
  return new Request("https://test.local/api/internal/captions/room-config", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.authOk = true;
  state.enabled = true;
  state.bookingId = "b1";
  state.config = {
    bookingId: "b1",
    teacherId: "t1",
    studentId: "s1",
    teacherDirection: { source: "es", target: "en" },
    studentDirection: { source: "en", target: "es" },
    studentCaptionsAllowed: true,
  };
  state.gateOk = true;
});

describe("POST /api/internal/captions/room-config", () => {
  it("404s when the shared-secret auth fails", async () => {
    state.authOk = false;
    const res = await POST(req({ room: "class-b1" }));
    expect(res.status).toBe(404);
    expect(resolveClassCallRoomConfig).not.toHaveBeenCalled();
  });

  it("enabled:false when the feature flag/vendor keys are off, without touching the DB", async () => {
    state.enabled = false;
    const res = await POST(req({ room: "class-b1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(resolveClassCallRoomConfig).not.toHaveBeenCalled();
  });

  it("enabled:false for a room name that isn't a class room", async () => {
    state.bookingId = null;
    const res = await POST(req({ room: "something-else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
  });

  it("404s when the booking can't be resolved", async () => {
    state.config = null;
    const res = await POST(req({ room: "class-b1" }));
    expect(res.status).toBe(404);
  });

  it("enabled:false when the booking's teacher is not on Pro", async () => {
    state.gateOk = false;
    const res = await POST(req({ room: "class-b1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
  });

  it("200 with the full room config on the happy path", async () => {
    const res = await POST(req({ room: "class-b1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enabled: true,
      bookingId: "b1",
      teacherId: "t1",
      studentId: "s1",
      teacherDirection: { source: "es", target: "en" },
      studentDirection: { source: "en", target: "es" },
      studentCaptionsAllowed: true,
    });
  });

  it("400 on a malformed body", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});
