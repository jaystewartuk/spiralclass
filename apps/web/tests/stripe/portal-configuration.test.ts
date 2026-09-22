import { describe, expect, it } from "vitest";
import {
  buildPortalConfigurationParams,
  type PortalConfigurationContext,
} from "@/lib/stripe/portal-configuration";

const MONTHLY = "price_monthly";
const ANNUAL = "price_annual";
// Not a parameter of the builder — declared here only so the tests can prove it
// never appears in the output.
const FOUNDING = "price_founding";

const ctx: PortalConfigurationContext = {
  productId: "prod_plans",
  monthlyPriceId: MONTHLY,
  annualPriceId: ANNUAL,
  appUrl: "https://spiralclass.com/",
};

describe("buildPortalConfigurationParams", () => {
  // THE trap. All three plans are prices on one product, so enabling plan
  // switching by naming the PRODUCT would let any subscriber move herself onto
  // the £5.99 founding price from the portal — past the cohort cap, past the
  // cutoff, and permanently, because founding is price-locked for the life of
  // the subscription. Stripe's portal cannot be taught our cohort rules.
  it("never lets a subscriber switch herself onto the founding price", () => {
    const params = buildPortalConfigurationParams(ctx);
    const update = params.features?.subscription_update;

    expect(update?.enabled).toBe(true);
    const products = Array.isArray(update?.products) ? update.products : [];
    expect(products).toHaveLength(1);
    expect(products[0]?.prices).toEqual([MONTHLY, ANNUAL]);
    expect(products[0]?.prices).not.toContain(FOUNDING);
    // Belt and braces: the founding id must not appear anywhere in the config,
    // however the shape is later refactored.
    expect(JSON.stringify(params)).not.toContain(FOUNDING);
  });

  it("offers only a price change, not quantity or anything else", () => {
    const update = buildPortalConfigurationParams(ctx).features?.subscription_update;
    expect(update?.default_allowed_updates).toEqual(["price"]);
  });

  // Upgrading mid-cycle credits the time she has already paid for; downgrading
  // waits until that time is used up, rather than taking Pro away early and
  // handing back a credit she did not ask for.
  it("prorates an upgrade immediately and defers a downgrade to period end", () => {
    const update = buildPortalConfigurationParams(ctx).features?.subscription_update;
    expect(update?.proration_behavior).toBe("create_prorations");
    expect(update?.schedule_at_period_end?.conditions).toEqual([
      { type: "decreasing_item_amount" },
    ]);
  });

  // This is what produces `cancel_at_period_end` — the flag the billing webhook
  // records and the settings page reads to say "Ends" instead of "Renews". If
  // the mode ever became `immediately`, that whole path would go quiet.
  it("cancels at period end with no proration, matching the documented policy", () => {
    const cancel = buildPortalConfigurationParams(ctx).features?.subscription_cancel;
    expect(cancel?.enabled).toBe(true);
    expect(cancel?.mode).toBe("at_period_end");
    expect(cancel?.proration_behavior).toBe("none");
  });

  it("keeps the card and invoice history reachable — the portal's whole job", () => {
    const features = buildPortalConfigurationParams(ctx).features;
    expect(features?.payment_method_update?.enabled).toBe(true);
    expect(features?.invoice_history?.enabled).toBe(true);
  });

  // Nothing computes tax yet, so collecting a VAT number here would sit unused
  // and imply we do something with it.
  it("does not collect a tax id it has no use for", () => {
    const allowed = buildPortalConfigurationParams(ctx).features?.customer_update?.allowed_updates;
    expect(allowed).not.toContain("tax_id");
    expect(allowed).toContain("address");
  });

  it("links the policies Stripe renders in the portal, without a double slash", () => {
    const profile = buildPortalConfigurationParams(ctx).business_profile;
    expect(profile?.privacy_policy_url).toBe("https://spiralclass.com/privacy");
    expect(profile?.terms_of_service_url).toBe("https://spiralclass.com/terms");
  });
});
