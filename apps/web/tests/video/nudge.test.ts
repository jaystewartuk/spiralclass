import { describe, expect, it, vi } from "vitest";

// nudge.ts is a server module (`import "server-only"`); neutralize that guard so
// it can be unit-tested under the node runner (the same pattern as the call
// service tests).
vi.mock("server-only", () => ({}));

import type { PrismaClient } from "@prisma/client";
import { createStubWebPushClient } from "@/lib/notifications/web-push";
import { nudgeCounterparty, type NudgeDeps } from "@/lib/video/nudge";

const BOOKING = "bk_1";
const TEACHER = "tt-1111";
const STUDENT = "ss-2222";

// Minimal db double: the three reads the core makes, plus the soft-revoke write.
function fakeDb(opts: {
  endpoints?: string[];
  teacherLocale?: string;
  studentLocale?: string;
  revoked?: string[];
}): PrismaClient {
  return {
    webPushSubscription: {
      findMany: async () =>
        (opts.endpoints ?? []).map((endpoint, i) => ({
          id: `sub${i + 1}`,
          endpoint,
          p256dh: "p256dh-key",
          auth: "auth-key",
        })),
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        opts.revoked?.push(...where.id.in);
        return { count: where.id.in.length };
      },
    },
    teacher: {
      findUnique: async () => ({ locale: opts.teacherLocale ?? "en" }),
    },
    student: {
      findUnique: async () => ({ locale: opts.studentLocale ?? "en" }),
    },
  } as unknown as PrismaClient;
}

// Deps with all three seams stubbed. `participants` seeds the room; `cooldown`
// forces the limiter to reject; `outcomes` drives the push service's answer.
function deps(
  opts: {
    participants?: string[];
    cooldown?: boolean;
    outcomes?: Record<string, "delivered" | "gone" | "failed">;
  } = {},
): NudgeDeps & { webPush: ReturnType<typeof createStubWebPushClient> } {
  const webPush = createStubWebPushClient(opts.outcomes);
  return {
    webPush,
    listParticipants: async () => opts.participants ?? [],
    rateLimiter: async () =>
      opts.cooldown ? { ok: false, retryAfterMs: 30_000 } : { ok: true, retryAfterMs: 0 },
  };
}

describe("nudgeCounterparty", () => {
  it("pushes to every live subscription and reports the delivered count", async () => {
    const d = deps();
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/a", "https://push.example/b"] }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      d,
    );
    expect(res).toEqual({ ok: true, delivered: 2 });
    expect(d.webPush.sentBatches).toHaveLength(1);
    const batch = d.webPush.sentBatches[0];
    expect(batch.subscriptions.map((s) => s.endpoint)).toEqual([
      "https://push.example/a",
      "https://push.example/b",
    ]);
    // Time-sensitive → the same urgency the dispatcher reserves for bookings.
    expect(batch.payload.urgent).toBe(true);
    // One nudge per booking per recipient: a re-press replaces, never stacks.
    expect(batch.payload.tag).toBe(`class-nudge:${BOOKING}`);
    // A teacher recipient deep-links to the teacher class screen.
    expect(batch.payload.deepLink).toBe(`/dashboard/classes/${BOOKING}`);
    // Default (English) copy names the caller.
    expect(batch.payload.title).toBe("Your class is waiting");
    expect(batch.payload.body).toContain("Mira");
  });

  it("translates the student deep-link out of its role prefix and uses Spanish copy", async () => {
    // Regression: `s/class/<id>` is an app-router path, not a web route. Rooted
    // at "/" it 404s, so the nudge has to arrive already translated.
    const d = deps();
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/s"], studentLocale: "es-MX" }),
      {
        bookingId: BOOKING,
        callerIdentity: TEACHER,
        callerName: "Prof",
        to: { type: "student", id: STUDENT },
      },
      d,
    );
    expect(res).toEqual({ ok: true, delivered: 1 });
    const batch = d.webPush.sentBatches[0];
    expect(batch.payload.deepLink).toBe(`/my-classes/${BOOKING}`);
    expect(batch.payload.title).toBe("Tu clase te espera");
    expect(batch.payload.body).toContain("Prof");
  });

  it("returns cooldown and sends nothing when rate-limited", async () => {
    const d = deps({ cooldown: true });
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/a"] }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "cooldown", retryAfterSec: 30 });
    expect(d.webPush.sentBatches).toHaveLength(0);
  });

  it("skips when someone other than the caller is already in the room", async () => {
    const d = deps({ participants: [TEACHER] }); // the counterparty is already here
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/a"] }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      d,
    );
    expect(res).toEqual({ ok: false, reason: "already-present" });
    expect(d.webPush.sentBatches).toHaveLength(0);
  });

  it("still nudges when only the caller is in the room", async () => {
    const d = deps({ participants: [STUDENT] }); // caller alone; counterparty missing
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/a"] }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      d,
    );
    expect(res).toEqual({ ok: true, delivered: 1 });
    expect(d.webPush.sentBatches).toHaveLength(1);
  });

  it("is a no-op (delivered 0) when the recipient has no subscriptions", async () => {
    const d = deps();
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: [] }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      d,
    );
    expect(res).toEqual({ ok: true, delivered: 0 });
    expect(d.webPush.sentBatches).toHaveLength(0);
  });

  it("reports delivered 0 — never a delivery — when the transport is unconfigured", async () => {
    // The regression that was fixed later: for a month this returned
    // `{ ok: true, delivered: 0 }` on EVERY press because the only transport it
    // knew had been removed. The waiting-room UI reads `ok` alone,
    // so it said "Sent" to nobody. `delivered` is the honest field, and a
    // VAPID-less deploy must not claim otherwise.
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/a"] }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      {
        webPush: null,
        listParticipants: async () => [],
        rateLimiter: async () => ({ ok: true, retryAfterMs: 0 }),
      },
    );
    expect(res).toEqual({ ok: true, delivered: 0 });
  });

  it("soft-revokes a subscription the push service reports as permanently gone", async () => {
    // Otherwise a dead browser registration keeps the recipient looking
    // reachable forever, and every nudge runs a doomed send.
    const revoked: string[] = [];
    const d = deps({ outcomes: { "https://push.example/dead": "gone" } });
    const res = await nudgeCounterparty(
      fakeDb({ endpoints: ["https://push.example/dead"], revoked }),
      {
        bookingId: BOOKING,
        callerIdentity: STUDENT,
        callerName: "Mira",
        to: { type: "teacher", id: TEACHER },
      },
      d,
    );
    expect(res).toEqual({ ok: true, delivered: 0 });
    expect(revoked).toEqual(["sub1"]);
  });
});
