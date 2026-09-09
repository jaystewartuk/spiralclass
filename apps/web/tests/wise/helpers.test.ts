import { describe, expect, it } from "vitest";
import { buildWisePayUrl } from "@/lib/wise";
import { generatePaymentReference } from "@/lib/payments/reference";
import { priceForMethod } from "@/lib/payments/instruments";
import { isInstrumentReady } from "@spiralclass/shared";

describe("generatePaymentReference", () => {
  it("derives a 12-char hex slug from the external reference UUID (audit M-8)", () => {
    const ref = generatePaymentReference("1a2b3c4d-1111-2222-3333-444455556666");
    expect(ref).toBe("AGP-1A2B3C4D1111");
  });

  it("is deterministic — same UUID, same reference (so we can backfill)", () => {
    const a = generatePaymentReference("deadbeef-cafe-1234-5678-901234567890");
    const b = generatePaymentReference("deadbeef-cafe-1234-5678-901234567890");
    expect(a).toBe(b);
  });

  it("upper-cases the hex prefix", () => {
    expect(generatePaymentReference("abcdef00-0000-0000-0000-000000000000")).toBe(
      "AGP-ABCDEF000000",
    );
  });
});

describe("buildWisePayUrl", () => {
  it("builds a Wise Quick-Pay URL with prefilled amount + currency", () => {
    const url = buildWisePayUrl({
      handle: "anal3829",
      amountMinorUnits: 232_000,
      currency: "MXN",
    });
    expect(url).toBe("https://wise.com/pay/me/anal3829?amount=2320.00&currency=MXN");
  });

  it("encodes the handle so a stray special char can't break the URL", () => {
    const url = buildWisePayUrl({ handle: "with space", amountMinorUnits: 100 });
    // URL.encode turns ' ' into %20 (not '+'), per encodeURIComponent.
    expect(url).toContain("https://wise.com/pay/me/with%20space?");
  });

  it("formats minor units with 2 decimal places (no integer truncation)", () => {
    const url = buildWisePayUrl({ handle: "x", amountMinorUnits: 12_345 });
    expect(url).toContain("amount=123.45");
  });

  it("formats the amount to the currency's own decimal count (0-decimal)", () => {
    // JPY has no minor unit: 1500 minor units == ¥1500, formatted with no
    // decimals and the currency echoed through to the URL.
    const url = buildWisePayUrl({ handle: "x", amountMinorUnits: 1500, currency: "JPY" });
    expect(url).toContain("amount=1500&");
    expect(url).toContain("currency=JPY");
  });

  it("includes the reference as a hint param when provided", () => {
    const url = buildWisePayUrl({
      handle: "x",
      amountMinorUnits: 100,
      reference: "AGP-1A2B3C4D",
    });
    expect(url).toContain("reference=AGP-1A2B3C4D");
  });
});

describe("priceForMethod", () => {
  it("uses priceMinorUnits for stripe regardless of wise override", () => {
    const got = priceForMethod(
      { priceMinorUnits: 240_000, transferPriceMinorUnits: 232_000 },
      "stripe",
    );
    expect(got).toBe(240_000);
  });

  it("uses transferPriceMinorUnits for wise when set", () => {
    const got = priceForMethod(
      { priceMinorUnits: 240_000, transferPriceMinorUnits: 232_000 },
      "manual_transfer",
    );
    expect(got).toBe(232_000);
  });

  it("falls back to priceMinorUnits for wise when wisePrice is null", () => {
    const got = priceForMethod(
      { priceMinorUnits: 240_000, transferPriceMinorUnits: null },
      "manual_transfer",
    );
    expect(got).toBe(240_000);
  });

  it("respects a Wise price of zero (does NOT treat 0 as fallback)", () => {
    const got = priceForMethod(
      { priceMinorUnits: 240_000, transferPriceMinorUnits: 0 },
      "manual_transfer",
    );
    expect(got).toBe(0);
  });
});

// Replaces the pre-D-113 `isWiseReady(teacher)`: same question, now asked of
// one instrument instead of the whole teacher.
describe("isInstrumentReady (wise)", () => {
  const wise = (over: Partial<{ enabled: boolean; wiseHandle: string | null }> = {}) => ({
    kind: "wise" as const,
    enabled: true,
    wiseHandle: "x" as string | null,
    schemeId: null,
    details: null,
    ...over,
  });

  it("is true when enabled + handle on file", () => {
    expect(isInstrumentReady(wise())).toBe(true);
  });

  it("is false when disabled, even with a handle", () => {
    expect(isInstrumentReady(wise({ enabled: false }))).toBe(false);
  });

  it("is false when enabled but handle is null (the form refuses this state)", () => {
    expect(isInstrumentReady(wise({ wiseHandle: null }))).toBe(false);
  });
});
