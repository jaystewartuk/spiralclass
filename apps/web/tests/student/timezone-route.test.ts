import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// POST /api/student/timezone — one-shot IANA timezone capture, called
// by CaptureTimezone (my-classes/capture-timezone.tsx) right after a fresh
// student sign-in. Pins: CSRF rejection, body validation, the auth/no-student
// guards, the "only set if missing" one-shot contract, and the happy path.

const state = {
  user: { id: "u1", email: "mira@x.com" } as { id: string; email: string } | null,
  student: { id: "s1", timezone: null as string | null } as {
    id: string;
    timezone: string | null;
  } | null,
};

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => state.user),
}));

const update = vi.fn(async (_args: unknown) => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    student: {
      findFirst: vi.fn(async () => state.student),
      update: (args: unknown) => update(args),
    },
  },
}));

const { POST } = await import("@/app/api/student/timezone/route");

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new Request("https://test.local/api/student/timezone", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "u1", email: "mira@x.com" };
  state.student = { id: "s1", timezone: null };
});

describe("POST /api/student/timezone", () => {
  it("403s a cross-origin caller before touching auth or the DB", async () => {
    const res = await POST(
      post({ timezone: "America/Mexico_City" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "cross-origin" });
    expect(update).not.toHaveBeenCalled();
  });

  it("400s an invalid body", async () => {
    const res = await POST(post({ timezone: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid-body" });
  });

  it("401s when signed out", async () => {
    state.user = null;
    const res = await POST(post({ timezone: "America/Mexico_City" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "no-session" });
  });

  it("403s when the caller has no student row", async () => {
    state.student = null;
    const res = await POST(post({ timezone: "America/Mexico_City" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "no-student" });
  });

  it("captures the timezone on first call", async () => {
    const res = await POST(post({ timezone: "America/Mexico_City" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: true });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: { timezone: "America/Mexico_City" },
      }),
    );
  });

  it("is a one-shot no-op once a timezone is already set", async () => {
    state.student = { id: "s1", timezone: "America/Bogota" };
    const res = await POST(post({ timezone: "America/Mexico_City" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: false });
    expect(update).not.toHaveBeenCalled();
  });
});
