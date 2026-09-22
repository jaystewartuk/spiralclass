import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NotificationStatus } from "@prisma/client";

import {
  handleResendWebhook,
  verifyResendSignature,
  type EmailWebhookPrisma,
} from "@/lib/notifications/email-webhook";

// An email notification's terminal state used to be `sent`, which only meant
// "Resend's API returned an id". On 2026-08-31 two purchase emails were
// recorded `sent`, with provider ids, that Resend never attempted — the
// recipient was on its suppression list from earlier hard bounces. Nothing in
// the data distinguished that from success.
//
// That is not a one-off: any student whose address hard-bounces once is
// suppressed from then on, and every later notification would read `sent` for
// ever while they receive nothing. These delivery receipts are what write the
// `delivered` / `failed` states the enum already had.

const SECRET = "whsec_" + Buffer.from("super-secret-key").toString("base64");

function sign(rawBody: string, id: string, timestamp: number, secret = SECRET) {
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return `v1,${sig}`;
}

describe("verifyResendSignature", () => {
  const body = JSON.stringify({ type: "email.delivered" });
  const id = "msg_1";
  const now = 1_700_000_000;

  it("accepts a correctly signed payload", () => {
    const res = verifyResendSignature({
      headers: { id, timestamp: String(now), signature: sign(body, id, now) },
      rawBody: body,
      secret: SECRET,
      nowSeconds: now,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const res = verifyResendSignature({
      headers: { id, timestamp: String(now), signature: sign(body, id, now) },
      rawBody: body + " ",
      secret: SECRET,
      nowSeconds: now,
    });
    expect(res).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a replayed payload outside the tolerance", () => {
    const res = verifyResendSignature({
      headers: { id, timestamp: String(now), signature: sign(body, id, now) },
      rawBody: body,
      secret: SECRET,
      nowSeconds: now + 3600,
    });
    expect(res).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing headers rather than treating them as valid", () => {
    const res = verifyResendSignature({
      headers: { id: null, timestamp: null, signature: null },
      rawBody: body,
      secret: SECRET,
      nowSeconds: now,
    });
    expect(res).toEqual({ ok: false, reason: "missing-header" });
  });

  it("accepts when ANY v1 signature matches, so a secret rotation isn't an outage", () => {
    const other = "whsec_" + Buffer.from("previous-key").toString("base64");
    const header = `${sign(body, id, now, other)} ${sign(body, id, now)}`;
    const res = verifyResendSignature({
      headers: { id, timestamp: String(now), signature: header },
      rawBody: body,
      secret: SECRET,
      nowSeconds: now,
    });
    expect(res.ok).toBe(true);
  });
});

type FakeRow = { providerMessageId: string; status: NotificationStatus; error?: string };

// Types come from EmailWebhookPrisma, which is the two operations the handler
// uses rather than Prisma's full generated delegate — so the double is this
// small and still typechecks against the real client's shape.
function fakePrisma(rows: FakeRow[]): {
  prisma: { notification: EmailWebhookPrisma };
  rows: FakeRow[];
} {
  const notification: EmailWebhookPrisma = {
    async updateMany({ where, data }) {
      const row = rows.find(
        (r) =>
          r.providerMessageId === where.providerMessageId && where.status.in.includes(r.status),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    async findFirst({ where }) {
      return rows.find((r) => r.providerMessageId === where.providerMessageId) ?? null;
    },
  };
  return { prisma: { notification }, rows };
}

describe("handleResendWebhook", () => {
  it("marks a delivered email delivered", async () => {
    const env = fakePrisma([{ providerMessageId: "em_1", status: "sent" }]);
    const out = await handleResendWebhook(
      { type: "email.delivered", data: { email_id: "em_1" } },
      env,
    );
    expect(out).toMatchObject({ code: "applied", status: "delivered" });
    expect(env.rows[0].status).toBe("delivered");
  });

  it("marks a bounced email failed — the case that read as success", async () => {
    const env = fakePrisma([{ providerMessageId: "em_2", status: "sent" }]);
    const out = await handleResendWebhook(
      { type: "email.bounced", data: { email_id: "em_2" } },
      env,
    );
    expect(out).toMatchObject({ code: "applied", status: "failed" });
    expect(env.rows[0].status).toBe("failed");
    expect(env.rows[0].error).toBe("resend:email.bounced");
  });

  it("does not drag a delivered row backwards on a late duplicate", async () => {
    const env = fakePrisma([{ providerMessageId: "em_3", status: "delivered" }]);
    const out = await handleResendWebhook(
      { type: "email.bounced", data: { email_id: "em_3" } },
      env,
    );
    expect(out).toEqual({ code: "noop", reason: "already-delivered" });
    expect(env.rows[0].status).toBe("delivered");
  });

  it("leaves our own deliberate `suppressed` alone", async () => {
    // `suppressed` means WE chose not to send (opt-out). A provider event must
    // not repaint that as a delivery failure.
    const env = fakePrisma([{ providerMessageId: "em_4", status: "suppressed" }]);
    const out = await handleResendWebhook(
      { type: "email.delivered", data: { email_id: "em_4" } },
      env,
    );
    expect(out).toEqual({ code: "noop", reason: "already-suppressed" });
    expect(env.rows[0].status).toBe("suppressed");
  });

  it("treats a spam complaint as delivered, not failed", async () => {
    // It WAS delivered — folding complaints into `failed` would make the
    // delivery numbers wrong in the other direction.
    const env = fakePrisma([{ providerMessageId: "em_5", status: "sent" }]);
    const out = await handleResendWebhook(
      { type: "email.complained", data: { email_id: "em_5" } },
      env,
    );
    expect(out).toEqual({ code: "ignored-unhandled-type", type: "email.complained" });
    expect(env.rows[0].status).toBe("sent");
  });

  it("reports an unknown message id rather than silently doing nothing", async () => {
    const env = fakePrisma([]);
    const out = await handleResendWebhook(
      { type: "email.delivered", data: { email_id: "em_missing" } },
      env,
    );
    expect(out).toEqual({ code: "no-notification-row", providerMessageId: "em_missing" });
  });

  it("ignores events that carry no outcome", async () => {
    const env = fakePrisma([{ providerMessageId: "em_6", status: "sent" }]);
    for (const type of ["email.sent", "email.opened", "email.clicked"]) {
      const out = await handleResendWebhook({ type, data: { email_id: "em_6" } }, env);
      expect(out).toEqual({ code: "ignored-unhandled-type", type });
    }
    expect(env.rows[0].status).toBe("sent");
  });

  it("rejects a malformed payload", async () => {
    const env = fakePrisma([]);
    expect(await handleResendWebhook(null, env)).toMatchObject({ code: "ignored-malformed" });
    expect(await handleResendWebhook({ data: {} }, env)).toEqual({
      code: "ignored-malformed",
      reason: "missing-type",
    });
    expect(await handleResendWebhook({ type: "email.delivered", data: {} }, env)).toEqual({
      code: "ignored-malformed",
      reason: "missing-email-id",
    });
  });
});
