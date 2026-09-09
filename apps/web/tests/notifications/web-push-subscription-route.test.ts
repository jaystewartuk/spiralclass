import { beforeEach, describe, expect, it, vi } from "vitest";

// POST/DELETE /api/web-push/subscription — browser Web Push registration, the
// session-authed web counterpart of /api/mobile/devices. The behaviour worth
// pinning here is ownership scoping: endpoints are the address a notification
// is delivered to, so a route that let anyone claim or revoke someone else's
// endpoint would let them redirect or silence that person's notifications.

const getAuthUser = vi.fn<() => Promise<{ id: string; email: string } | null>>();
vi.mock("@/lib/auth", () => ({ getAuthUser: () => getAuthUser() }));

const vapidConfig = vi.fn<() => { publicKey: string; privateKey: string; subject: string } | null>(
  () => ({ publicKey: "pub", privateKey: "priv", subject: "mailto:ops@spiralclass.com" }),
);
vi.mock("@/lib/notifications/web-push", () => ({ vapidConfig: () => vapidConfig() }));

const teacherFindUnique = vi.fn();
const studentFindFirst = vi.fn();
const subFindUnique = vi.fn();
// Typed with an explicit arg so the call sites below (which pass the Prisma
// args object through) typecheck — a bare `async () => …` infers a 0-arity
// mock.
const subUpsert = vi.fn(async (_args: unknown) => ({ id: "sub-row-1" }));
const subFindMany = vi.fn(async (_args: unknown) => [] as { id: string }[]);
const subUpdateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: (a: unknown) => teacherFindUnique(a) },
    student: { findFirst: (a: unknown) => studentFindFirst(a) },
    webPushSubscription: {
      findUnique: (a: unknown) => subFindUnique(a),
      upsert: (a: unknown) => subUpsert(a),
      findMany: (a: unknown) => subFindMany(a),
      updateMany: (a: unknown) => subUpdateMany(a),
    },
  },
}));

const { GET, POST, DELETE } = await import("@/app/api/web-push/subscription/route");

const ENDPOINT = "https://push.example/sub-abc";
const VALID_BODY = { endpoint: ENDPOINT, keys: { p256dh: "k", auth: "a" } };

function post(body: unknown): Request {
  return new Request("http://test.local/api/web-push/subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(body: unknown): Request {
  return new Request("http://test.local/api/web-push/subscription", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ id: "user-1", email: "mira@example.com" });
  vapidConfig.mockReturnValue({
    publicKey: "pub",
    privateKey: "priv",
    subject: "mailto:ops@spiralclass.com",
  });
  teacherFindUnique.mockResolvedValue({ id: "user-1" });
  studentFindFirst.mockResolvedValue(null);
  subFindUnique.mockResolvedValue(null);
  subUpsert.mockResolvedValue({ id: "sub-row-1" });
  subFindMany.mockResolvedValue([]);
});

describe("GET /api/web-push/subscription", () => {
  it("returns the VAPID public key so the browser can subscribe", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, publicKey: "pub" });
  });

  it("reports disabled — never a key — when VAPID isn't configured", async () => {
    vapidConfig.mockReturnValue(null);
    const res = await GET();
    expect(await res.json()).toEqual({ enabled: false, publicKey: null });
  });

  it("401s an anonymous caller", async () => {
    getAuthUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});

describe("POST /api/web-push/subscription", () => {
  it("stores a new subscription against the caller's teacher row", async () => {
    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(200);
    expect(subUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { endpoint: ENDPOINT },
        create: expect.objectContaining({
          endpoint: ENDPOINT,
          p256dh: "k",
          auth: "a",
          recipientType: "teacher",
          recipientId: "user-1",
        }),
      }),
    );
  });

  it("resolves a student caller to their student row", async () => {
    teacherFindUnique.mockResolvedValue(null);
    studentFindFirst.mockResolvedValue({ id: "student-9" });

    await POST(post(VALID_BODY));

    expect(subUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          recipientType: "student",
          recipientId: "student-9",
        }),
      }),
    );
  });

  it("refreshes the encryption keys on re-subscribe", async () => {
    // The browser rotates p256dh/auth when it rotates a subscription. Keeping
    // a stale pair makes every send fail encryption — silently, since the push
    // service still accepts the request.
    subFindUnique.mockResolvedValue({
      recipientType: "teacher",
      recipientId: "user-1",
      revokedAt: null,
    });

    await POST(post({ endpoint: ENDPOINT, keys: { p256dh: "new-k", auth: "new-a" } }));

    expect(subUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ p256dh: "new-k", auth: "new-a", revokedAt: null }),
      }),
    );
  });

  it("refuses to re-point a LIVE subscription owned by a different recipient", async () => {
    subFindUnique.mockResolvedValue({
      recipientType: "student",
      recipientId: "someone-else",
      revokedAt: null,
    });

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "subscription-owned-by-another-recipient" });
    expect(subUpsert).not.toHaveBeenCalled();
  });

  it("allows reclaiming a REVOKED subscription (shared browser, prior user signed out)", async () => {
    subFindUnique.mockResolvedValue({
      recipientType: "student",
      recipientId: "someone-else",
      revokedAt: new Date(),
    });

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(200);
    expect(subUpsert).toHaveBeenCalled();
  });

  it("503s rather than storing a subscription it could never send to", async () => {
    // Storing one would make the recipient look push-reachable to the
    // dispatcher while every send failed — suppressing the email that would
    // otherwise have reached them.
    vapidConfig.mockReturnValue(null);

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(503);
    expect(subUpsert).not.toHaveBeenCalled();
  });

  it("401s an anonymous caller and 403s a user with no recipient row", async () => {
    getAuthUser.mockResolvedValue(null);
    expect((await POST(post(VALID_BODY))).status).toBe(401);

    getAuthUser.mockResolvedValue({ id: "user-1", email: "mira@example.com" });
    teacherFindUnique.mockResolvedValue(null);
    studentFindFirst.mockResolvedValue(null);
    expect((await POST(post(VALID_BODY))).status).toBe(403);
  });

  it("400s a malformed body instead of storing junk", async () => {
    expect(
      (await POST(post({ endpoint: "not-a-url", keys: { p256dh: "k", auth: "a" } }))).status,
    ).toBe(400);
    expect((await POST(post({ endpoint: ENDPOINT }))).status).toBe(400);
  });

  it("caps the fan-out at 5 live subscriptions per recipient", async () => {
    subFindMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);

    await POST(post(VALID_BODY));

    expect(subFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5 }));
    expect(subUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["old-1", "old-2"] } } }),
    );
  });
});

describe("DELETE /api/web-push/subscription", () => {
  it("revokes only within the caller's own recipient scope", async () => {
    const res = await DELETE(del({ endpoint: ENDPOINT }));

    expect(res.status).toBe(200);
    // The recipient predicate is the guard: without it, anyone who learned
    // another user's endpoint could silently suppress their notifications.
    expect(subUpdateMany).toHaveBeenCalledWith({
      where: {
        endpoint: ENDPOINT,
        recipientType: "teacher",
        recipientId: "user-1",
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("401s an anonymous caller", async () => {
    getAuthUser.mockResolvedValue(null);
    expect((await DELETE(del({ endpoint: ENDPOINT }))).status).toBe(401);
    expect(subUpdateMany).not.toHaveBeenCalled();
  });
});
