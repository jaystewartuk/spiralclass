import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "@/lib/stripe/signature";

const SECRET = "whsec_test-secret-abcdef1234567890";
const RAW_BODY = '{"id":"evt_TEST_1","type":"checkout.session.completed","data":{"object":{}}}';
const TS_SEC = Math.floor(new Date("2026-04-24T12:00:00Z").getTime() / 1000);

// The wrapper delegates to stripe.webhooks.constructEvent, which reads the
// real clock internally (no injectable `now` seam) — so tests that need a
// fixed "current time" control it via vi.setSystemTime instead.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TS_SEC * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("verifyWebhookSignature (Stripe)", () => {
  it("accepts a freshly-signed body", () => {
    const header = signWebhookBody({ rawBody: RAW_BODY, secret: SECRET, timestampSeconds: TS_SEC });
    const result = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when signature header is missing", () => {
    const result = verifyWebhookSignature({
      signatureHeader: null,
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "missing-header" });
  });

  it("rejects a malformed signature header (no v1=)", () => {
    const result = verifyWebhookSignature({
      signatureHeader: "ts=12345",
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "malformed-header" });
  });

  it("rejects a malformed signature header (no t=)", () => {
    const result = verifyWebhookSignature({
      signatureHeader: "v1=deadbeef",
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "malformed-header" });
  });

  it("rejects a tampered body", () => {
    const header = signWebhookBody({ rawBody: RAW_BODY, secret: SECRET, timestampSeconds: TS_SEC });
    const result = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: RAW_BODY + "tampered",
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature computed with the wrong secret", () => {
    const header = signWebhookBody({
      rawBody: RAW_BODY,
      secret: "whsec_wrong",
      timestampSeconds: TS_SEC,
    });
    const result = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a stale signature older than the tolerance window", () => {
    const header = signWebhookBody({ rawBody: RAW_BODY, secret: SECRET, timestampSeconds: TS_SEC });
    vi.setSystemTime((TS_SEC + 6 * 60) * 1000);
    const result = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: RAW_BODY,
      secret: SECRET,
      // default tolerance = 5 min
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts a signature within the default tolerance", () => {
    const header = signWebhookBody({ rawBody: RAW_BODY, secret: SECRET, timestampSeconds: TS_SEC });
    vi.setSystemTime((TS_SEC + 4 * 60) * 1000);
    const result = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a header with multiple v1 values (legacy + new key rotation)", () => {
    // Stripe's docs note that during key rotation a header may carry
    // both the old and new v1 sigs. As long as one matches we accept.
    const validHeader = signWebhookBody({
      rawBody: RAW_BODY,
      secret: SECRET,
      timestampSeconds: TS_SEC,
    });
    // Append a bogus v1.
    const concat = `${validHeader},v1=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`;
    const result = verifyWebhookSignature({
      signatureHeader: concat,
      rawBody: RAW_BODY,
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });
});
