import { describe, expect, it } from "vitest";

import {
  V2_REJECTED_CAPABILITIES,
  bankTransferTypeFor,
  localPaymentCapabilitiesFor,
} from "./stripe-capabilities";

// Every country the registry has an opinion about. Kept explicit rather than
// exported from the module: the point of these tests is to pin the answers, and
// iterating the same object the code iterates would pin nothing.
const CURATED = ["MX", "BR", "NL", "PL", "BE", "AT", "JP"] as const;

describe("localPaymentCapabilitiesFor", () => {
  it("returns Mexico's two local rails — the pair D-143 exists for", () => {
    expect(localPaymentCapabilitiesFor("MX")).toEqual([
      "oxxo_payments",
      "mx_bank_transfer_payments",
    ]);
  });

  it("is case-insensitive, because callers pass the raw country column", () => {
    expect(localPaymentCapabilitiesFor("mx")).toEqual(localPaymentCapabilitiesFor("MX"));
  });

  it("returns an empty array for an uncurated country rather than throwing", () => {
    // GB is the platform's own country and has no curated local method: a
    // British teacher sells on cards and the wallets that ride on them.
    expect(localPaymentCapabilitiesFor("GB")).toEqual([]);
    expect(localPaymentCapabilitiesFor("ZZ")).toEqual([]);
  });

  it("does not leak a mutable array to callers", () => {
    // `readonly` is erased at runtime, so without Object.freeze one stray push
    // in a caller would poison this country's capability set for every
    // subsequent teacher in the process. Frozen, the push throws — but the
    // guarantee under test is that the registry is unchanged either way.
    const first = localPaymentCapabilitiesFor("MX") as string[];
    expect(() => first.push("mutated")).toThrow();
    expect(localPaymentCapabilitiesFor("MX")).not.toContain("mutated");
  });
});

// ── The regression these tests exist for ──────────────────────────────────
//
// `pix_payments` (Brazil) and `fpx_payments` (Malaysia) were both in the
// registry and both 400 `POST /v2/core/accounts`, so neither country could
// onboard AT ALL. A mocked Stripe accepts any string, so no amount of unit
// testing the client would have caught it — only the name itself can be pinned.
describe("v2 capability vocabulary", () => {
  it("never requests a capability measured as rejected by the v2 API", () => {
    const rejected = Object.keys(V2_REJECTED_CAPABILITIES);
    for (const country of CURATED) {
      for (const capability of localPaymentCapabilitiesFor(country)) {
        expect(
          rejected,
          `${country} requests ${capability}, which v2 refuses: ${V2_REJECTED_CAPABILITIES[capability]}`,
        ).not.toContain(capability);
      }
    }
  });

  it("keeps Brazil on Boleto only, with Pix deliberately absent", () => {
    // Not a preference — Pix has no v2 field. If this test is failing because
    // someone added it back, re-measure with scripts/probe-v2-capabilities.mjs
    // before deciding the test is wrong.
    expect(localPaymentCapabilitiesFor("BR")).toEqual(["boleto_payments"]);
  });

  it("has no Malaysia entry while business_type is uncollected at creation", () => {
    expect(localPaymentCapabilitiesFor("MY")).toEqual([]);
  });

  it("records why each rejected capability is unusable", () => {
    for (const [name, reason] of Object.entries(V2_REJECTED_CAPABILITIES)) {
      expect(name, "capability names are snake_case Stripe field names").toMatch(/^[a-z_]+$/);
      expect(reason.length, `${name} needs a reason a reader can act on`).toBeGreaterThan(20);
    }
  });
});

describe("bankTransferTypeFor", () => {
  it("names Mexico's SPEI variant", () => {
    expect(bankTransferTypeFor("MX")).toBe("mx_bank_transfer");
  });

  it("is case-insensitive, like the capability lookup beside it", () => {
    expect(bankTransferTypeFor("mx")).toBe("mx_bank_transfer");
  });

  it("returns null for a country with no known variant", () => {
    // Null must mean "do not send the option at all". A guessed
    // `<cc>_bank_transfer` string for an unsupported country is rejected by
    // Stripe and takes the entire checkout down with it, so silence is safe
    // and a plausible-looking guess is not.
    expect(bankTransferTypeFor("GB")).toBeNull();
    expect(bankTransferTypeFor("ZZ")).toBeNull();
  });

  // The two registries answer different questions — "may she offer it" and
  // "how does checkout ask for it" — but they must agree on WHO. A country with
  // the capability and no variant silently never offers bank transfer; one with
  // a variant and no capability asks for a method the account cannot do.
  it("agrees with the capability registry on which countries do bank transfer", () => {
    const BANK_TRANSFER_CAPABILITIES = ["mx_bank_transfer_payments", "jp_bank_transfer_payments"];
    for (const country of CURATED) {
      const hasCapability = localPaymentCapabilitiesFor(country).some((c) =>
        BANK_TRANSFER_CAPABILITIES.includes(c),
      );
      const hasVariant = bankTransferTypeFor(country) !== null;
      expect(
        hasVariant,
        `${country}: capability=${hasCapability} variant=${hasVariant} — these must match`,
      ).toBe(hasCapability);
    }
  });
});
