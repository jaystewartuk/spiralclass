import { describe, expect, it } from "vitest";
import {
  consumeNotificationLinkToken,
  issueNotificationLinkToken,
  NOTIFICATION_LINK_TTL_SECONDS,
} from "./notification-link";

type Row = { id: string; identifier: string; value: string; expiresAt: Date };

// An in-memory `verification` table with the two properties consumption relies
// on: rows are found by identifier, and a delete reports how many rows it
// actually removed.
function fakeDb() {
  const rows: Row[] = [];
  let nextId = 0;
  const db = {
    verification: {
      create: async ({ data }: { data: Omit<Row, "id"> }) => {
        const row = { id: `v-${++nextId}`, ...data };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: { identifier: string } }) =>
        rows.find((r) => r.identifier === where.identifier) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i === -1) return { count: 0 };
        rows.splice(i, 1);
        return { count: 1 };
      },
    },
  };
  return { db: db as never, rows };
}

const LINK = { studentId: "student-1", email: "Alumna@Example.com ", subjectId: "booking-1" };
const T0 = new Date("2026-09-14T12:00:00Z");

describe("issueNotificationLinkToken", () => {
  it("returns a 43-character base64url token and stores only its hash", async () => {
    const { db, rows } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier.startsWith("notification-link:rebook:")).toBe(true);
    expect(rows[0].identifier).not.toContain(token);
    expect(rows[0].value).not.toContain(token);
  });

  it("issues a different token every time, even for the same subject", async () => {
    const { db } = fakeDb();
    const a = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);
    const b = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);
    expect(a).not.toBe(b);
  });

  it("expires each kind at its own ceiling, and never later than it", async () => {
    const { db, rows } = fakeDb();
    await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);
    await issueNotificationLinkToken(db, { kind: "magic-link", ...LINK, ttlSeconds: 86_400 }, T0);
    await issueNotificationLinkToken(db, { kind: "magic-link", ...LINK, ttlSeconds: 600 }, T0);

    const lifetimes = rows.map((r) => (r.expiresAt.getTime() - T0.getTime()) / 1000);
    expect(lifetimes).toEqual([
      NOTIFICATION_LINK_TTL_SECONDS.rebook,
      NOTIFICATION_LINK_TTL_SECONDS["magic-link"],
      600,
    ]);
    expect(NOTIFICATION_LINK_TTL_SECONDS.rebook).toBeLessThanOrEqual(72 * 60 * 60);
    expect(NOTIFICATION_LINK_TTL_SECONDS["magic-link"]).toBe(60 * 60);
  });
});

describe("consumeNotificationLinkToken", () => {
  it("returns the payload it was issued with, email normalised", async () => {
    const { db } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);

    const result = await consumeNotificationLinkToken(db, "rebook", token, T0);
    expect(result).toEqual({
      ok: true,
      payload: { studentId: "student-1", email: "alumna@example.com", subjectId: "booking-1" },
    });
  });

  it("works exactly once", async () => {
    const { db } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);

    expect((await consumeNotificationLinkToken(db, "rebook", token, T0)).ok).toBe(true);
    expect(await consumeNotificationLinkToken(db, "rebook", token, T0)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("lets only one of two simultaneous redemptions through", async () => {
    const { db } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);

    const results = await Promise.all([
      consumeNotificationLinkToken(db, "rebook", token, T0),
      consumeNotificationLinkToken(db, "rebook", token, T0),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "already-used" });
  });

  it("refuses a token of the other kind", async () => {
    const { db } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);

    expect(await consumeNotificationLinkToken(db, "magic-link", token, T0)).toEqual({
      ok: false,
      reason: "not-found",
    });
    // …and the refusal did not spend it.
    expect((await consumeNotificationLinkToken(db, "rebook", token, T0)).ok).toBe(true);
  });

  it("refuses a lapsed token, and deletes it", async () => {
    const { db, rows } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "magic-link", ...LINK }, T0);
    const later = new Date(T0.getTime() + (NOTIFICATION_LINK_TTL_SECONDS["magic-link"] + 1) * 1000);

    expect(await consumeNotificationLinkToken(db, "magic-link", token, later)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(rows).toHaveLength(0);
  });

  it("refuses anything that is not token-shaped without reading the table", async () => {
    const { db } = fakeDb();
    for (const candidate of ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "", "a.b", "x".repeat(44)]) {
      expect(await consumeNotificationLinkToken(db, "rebook", candidate, T0)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses a row whose payload is not the shape it writes", async () => {
    const { db, rows } = fakeDb();
    const token = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);
    rows[0].value = "not json";
    expect(await consumeNotificationLinkToken(db, "rebook", token, T0)).toEqual({
      ok: false,
      reason: "bad-payload",
    });

    const second = await issueNotificationLinkToken(db, { kind: "rebook", ...LINK }, T0);
    rows[0].value = JSON.stringify({ s: "student-1" });
    expect(await consumeNotificationLinkToken(db, "rebook", second, T0)).toEqual({
      ok: false,
      reason: "bad-payload",
    });
  });
});
