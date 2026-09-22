import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// HTTP-contract tests for the Live Calls admin API surface — the
// service/provider logic is unit-tested separately (tests/live-calls,
// tests/video/providers). This pins: the auth gate on every route, the
// not-configured/upstream-error status codes, CSRF + rate-limit on the two
// mutating routes, and the service-reason → HTTP-status mapping.

const requireAdminMock = vi.fn(async (..._: unknown[]) => ({
  id: "admin-1",
  email: "a@b.co",
  role: "support" as const,
}));
vi.mock("@/lib/admin", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

let sameOrigin = true;
vi.mock("@/lib/auth/csrf", () => ({ isSameOrigin: () => sameOrigin }));

let rateLimitResult = { ok: true, retryAfterMs: 0 };
const rateLimitMock = vi.fn(async (..._a: unknown[]) => rateLimitResult);
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimitMock(...a) }));

const listActiveCallsMock = vi.fn();
const getCallDetailMock = vi.fn();
const endCallMock = vi.fn();
const disconnectCallParticipantMock = vi.fn();
vi.mock("@/lib/live-calls/service", () => ({
  listActiveCalls: (...a: unknown[]) => listActiveCallsMock(...a),
  getCallDetail: (...a: unknown[]) => getCallDetailMock(...a),
  endCall: (...a: unknown[]) => endCallMock(...a),
  disconnectCallParticipant: (...a: unknown[]) => disconnectCallParticipantMock(...a),
}));

const { GET: listGET } = await import("@/app/api/admin/live-calls/route");
const { GET: detailGET } = await import("@/app/api/admin/live-calls/[room]/route");
const { POST: endPOST } = await import("@/app/api/admin/live-calls/[room]/end/route");
const { POST: disconnectPOST } =
  await import("@/app/api/admin/live-calls/[room]/participants/[identity]/disconnect/route");

function get(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

function post(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  sameOrigin = true;
  rateLimitResult = { ok: true, retryAfterMs: 0 };
});

describe("GET /api/admin/live-calls", () => {
  it("requires at least support role", async () => {
    listActiveCallsMock.mockResolvedValueOnce({ dashboard: {}, rooms: [] });
    await listGET();
    expect(requireAdminMock).toHaveBeenCalledWith("support");
  });

  it("503s when no video provider is configured", async () => {
    listActiveCallsMock.mockResolvedValueOnce(null);
    const res = await listGET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: "not-configured" });
  });

  it("502s when the service throws (LiveKit unreachable)", async () => {
    listActiveCallsMock.mockRejectedValueOnce(new Error("network"));
    const res = await listGET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: "upstream-unavailable" });
  });

  it("returns the dashboard + rooms on success", async () => {
    const payload = { dashboard: { activeRooms: 1 }, rooms: [{ room: "class-b1" }] };
    listActiveCallsMock.mockResolvedValueOnce(payload);
    const res = await listGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...payload });
  });
});

describe("GET /api/admin/live-calls/[room]", () => {
  function call(room: string) {
    return detailGET(get(`https://x.test/api/admin/live-calls/${room}`), {
      params: Promise.resolve({ room }),
    });
  }

  it("404s when the room isn't found (already ended, or provider not configured)", async () => {
    getCallDetailMock.mockResolvedValueOnce(null);
    const res = await call("class-b1");
    expect(res.status).toBe(404);
  });

  it("502s when the service throws", async () => {
    getCallDetailMock.mockRejectedValueOnce(new Error("network"));
    const res = await call("class-b1");
    expect(res.status).toBe(502);
  });

  it("returns the room detail on success", async () => {
    getCallDetailMock.mockResolvedValueOnce({ room: "class-b1", participants: [] });
    const res = await call("class-b1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, room: { room: "class-b1", participants: [] } });
  });
});

describe("POST /api/admin/live-calls/[room]/end", () => {
  function call(body: unknown, room = "class-b1") {
    return endPOST(post(`https://x.test/api/admin/live-calls/${room}/end`, body), {
      params: Promise.resolve({ room }),
    });
  }

  it("403s on a cross-origin request", async () => {
    sameOrigin = false;
    const res = await call({ reason: "stuck" });
    expect(res.status).toBe(403);
    expect(endCallMock).not.toHaveBeenCalled();
  });

  it("400s on a missing/blank reason", async () => {
    const res = await call({ reason: "  " });
    expect(res.status).toBe(400);
    expect(endCallMock).not.toHaveBeenCalled();
  });

  it("429s and sets Retry-After when rate-limited", async () => {
    rateLimitResult = { ok: false, retryAfterMs: 12_345 };
    const res = await call({ reason: "stuck" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("13");
    expect(endCallMock).not.toHaveBeenCalled();
  });

  it("maps each service failure reason to its HTTP status", async () => {
    const cases: Array<[string, number]> = [
      ["unavailable", 503],
      ["not-found", 404],
      ["provider-error", 502],
    ];
    for (const [reason, status] of cases) {
      endCallMock.mockResolvedValueOnce({ ok: false, reason });
      const res = await call({ reason: "stuck" });
      expect(res.status, reason).toBe(status);
    }
  });

  it("ends the call with the actor and trimmed reason on success", async () => {
    endCallMock.mockResolvedValueOnce({ ok: true });
    const res = await call({ reason: "  stuck room  " }, "class-b1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(endCallMock).toHaveBeenCalledWith(
      "class-b1",
      expect.objectContaining({ id: "admin-1" }),
      "stuck room",
    );
  });
});

describe("POST /api/admin/live-calls/[room]/participants/[identity]/disconnect", () => {
  function call(body: unknown, room = "class-b1", identity = "s1") {
    return disconnectPOST(
      post(`https://x.test/api/admin/live-calls/${room}/participants/${identity}/disconnect`, body),
      { params: Promise.resolve({ room, identity }) },
    );
  }

  it("403s on a cross-origin request", async () => {
    sameOrigin = false;
    const res = await call({ reason: "acting out" });
    expect(res.status).toBe(403);
    expect(disconnectCallParticipantMock).not.toHaveBeenCalled();
  });

  it("400s on a missing reason", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
  });

  it("disconnects the participant on success", async () => {
    disconnectCallParticipantMock.mockResolvedValueOnce({ ok: true });
    const res = await call({ reason: "acting out" }, "class-b1", "s1");
    expect(res.status).toBe(200);
    expect(disconnectCallParticipantMock).toHaveBeenCalledWith(
      "class-b1",
      "s1",
      expect.objectContaining({ id: "admin-1" }),
      "acting out",
    );
  });

  it("maps not-found to 404", async () => {
    disconnectCallParticipantMock.mockResolvedValueOnce({ ok: false, reason: "not-found" });
    const res = await call({ reason: "acting out" });
    expect(res.status).toBe(404);
  });
});
