import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { parseStatementCredits, signToken } from "@/lib/wise/api";

// Statement parsing + SCA signing are the two pure, testable pieces of the
// Wise client. The HTTP/balance-resolution glue needs live creds, so it's
// validated against the sandbox manually (see .env.example).

describe("parseStatementCredits", () => {
  it("normalizes CREDIT lines to minor units and surfaces the reference", () => {
    const credits = parseStatementCredits({
      transactions: [
        {
          type: "CREDIT",
          date: "2026-06-02T09:00:00Z",
          amount: { value: 2320.0, currency: "MXN" },
          referenceNumber: "BAL-77",
          details: { paymentReference: "AGP-1A2B3C4D" },
        },
      ],
    });
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      externalId: "BAL-77",
      reference: "AGP-1A2B3C4D",
      amountMinorUnits: 232_000,
      currency: "MXN",
    });
  });

  it("falls back to the description when paymentReference is absent", () => {
    const [c] = parseStatementCredits({
      transactions: [
        {
          type: "CREDIT",
          date: "2026-06-02T09:00:00Z",
          amount: { value: 100, currency: "MXN" },
          details: { description: "Pago AGP-99887766" },
        },
      ],
    });
    expect(c?.reference).toBe("Pago AGP-99887766");
  });

  it("skips debits, zero/negative amounts, and undated lines", () => {
    const credits = parseStatementCredits({
      transactions: [
        { type: "DEBIT", date: "2026-06-02T09:00:00Z", amount: { value: 50, currency: "MXN" } },
        { type: "CREDIT", date: "2026-06-02T09:00:00Z", amount: { value: 0, currency: "MXN" } },
        { type: "CREDIT", amount: { value: 50, currency: "MXN" } },
      ],
    });
    expect(credits).toHaveLength(0);
  });

  it("handles fractional minor units with rounding", () => {
    const [c] = parseStatementCredits({
      transactions: [
        {
          type: "CREDIT",
          date: "2026-06-02T09:00:00Z",
          amount: { value: 1234.56, currency: "MXN" },
          referenceNumber: "BAL-1",
        },
      ],
    });
    expect(c?.amountMinorUnits).toBe(123_456);
  });

  it("uses the credit's currency exponent, not a hardcoded *100 (0-decimal)", () => {
    // A JPY credit of ¥1,500 is 1500 minor units — multiplying by 100 would
    // 100x the reconciled amount and never match the pending payment.
    const [c] = parseStatementCredits({
      transactions: [
        {
          type: "CREDIT",
          date: "2026-06-02T09:00:00Z",
          amount: { value: 1500, currency: "JPY" },
          referenceNumber: "BAL-JPY",
        },
      ],
    });
    expect(c?.amountMinorUnits).toBe(1500);
    expect(c?.currency).toBe("JPY");
  });
});

describe("signToken", () => {
  it("produces a base64 RSA-SHA256 signature the public key verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const ott = "one-time-token-abc123";
    const sig = signToken(ott, privateKey);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(ott);
    verifier.end();
    expect(verifier.verify(publicKey, sig, "base64")).toBe(true);
  });
});
