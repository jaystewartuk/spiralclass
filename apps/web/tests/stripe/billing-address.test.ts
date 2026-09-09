import { describe, expect, it } from "vitest";
import { capturedBillingFromAddress } from "@/lib/stripe/billing-address";

// VAT/GST readiness (global-launch item 7): normalize a Stripe address into the
// columns we persist. Blanks are dropped; a malformed country is nulled (the DB
// enforces alpha-2) but the rest of the address is still kept.

describe("capturedBillingFromAddress", () => {
  it("returns null for a missing address", () => {
    expect(capturedBillingFromAddress(null)).toBeNull();
    expect(capturedBillingFromAddress(undefined)).toBeNull();
  });

  it("returns null when every field is blank", () => {
    expect(capturedBillingFromAddress({ line1: "", line2: null, country: null })).toBeNull();
  });

  it("captures the country + full address, dropping blank fields", () => {
    expect(
      capturedBillingFromAddress({
        line1: "221B Baker St",
        line2: "",
        city: "London",
        state: null,
        postal_code: "NW1 6XE",
        country: "GB",
      }),
    ).toEqual({
      billingCountry: "GB",
      billingAddressJson: {
        line1: "221B Baker St",
        city: "London",
        postal_code: "NW1 6XE",
        country: "GB",
      },
    });
  });

  it("keeps the address but nulls a malformed country (DB alpha-2 guard)", () => {
    expect(capturedBillingFromAddress({ city: "Guadalajara", country: "mex" })).toEqual({
      billingCountry: null,
      billingAddressJson: { city: "Guadalajara", country: "mex" },
    });
  });
});
