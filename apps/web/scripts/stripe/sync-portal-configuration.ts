// Apply the Customer Portal configuration this repo declares.
//
// The declaration — and every decision in it — lives in
// src/lib/stripe/portal-configuration.ts and is unit-tested. This file is just
// the shell boundary: resolve ids, call Stripe, print what happened.
//
// Idempotent. It finds the configuration this script created before (by the
// `spiralclass_managed` metadata marker), updates it in place, and creates one
// only when there is none. So re-running after editing the declaration is the
// normal way to change the portal — not a Dashboard click, which is what this
// exists to stop being the source of truth.
//
// USAGE (from apps/web):
//
//   # against whatever STRIPE_SECRET_KEY is in the environment
//   pnpm stripe:portal:sync            # dry run: prints the diff, writes nothing
//   pnpm stripe:portal:sync --apply    # actually create/update
//
// It prints the configuration id. Put that in STRIPE_BILLING_PORTAL_CONFIG_ID
// for the environment you ran it against — production's lives in
// config/env/production.runtime.env alongside the price ids, since it is a
// non-secret identifier.
//
// The key it uses is the ambient STRIPE_SECRET_KEY, so running it against
// production means having production's key in the environment. There is no
// flag that picks an environment for you, deliberately: an accidental
// production write should require having deliberately loaded production
// credentials.

import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/lib/stripe/client";
import {
  buildPortalConfigurationParams,
  buildPortalConfigurationUpdateParams,
} from "@/lib/stripe/portal-configuration";

// Marks the configuration as this script's, so re-runs update rather than pile
// up new ones. Stripe has no "upsert by name" for portal configurations.
const MANAGED_MARKER = { spiralclass_managed: "portal-configuration" } as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Load the environment you mean to sync before running this.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
    apiVersion: STRIPE_API_VERSION,
  });

  const monthlyPriceId = requireEnv("STRIPE_PRICE_MONTHLY");
  const annualPriceId = requireEnv("STRIPE_PRICE_ANNUAL");
  const appUrl = requireEnv("APP_URL");

  // The product is READ from the monthly price rather than configured
  // separately: the three plan prices are all on one product, so a second env
  // var would only be a way for the two to disagree.
  const monthly = await stripe.prices.retrieve(monthlyPriceId);
  const productId = typeof monthly.product === "string" ? monthly.product : monthly.product.id;

  const annual = await stripe.prices.retrieve(annualPriceId);
  const annualProduct = typeof annual.product === "string" ? annual.product : annual.product.id;
  if (annualProduct !== productId) {
    throw new Error(
      `Monthly and annual prices are on different products (${productId} vs ${annualProduct}). ` +
        `The portal's subscription_update lists prices under ONE product; fix the prices first.`,
    );
  }

  const ctx = { productId, monthlyPriceId, annualPriceId, appUrl };
  const params = buildPortalConfigurationParams(ctx);

  const existing = await stripe.billingPortal.configurations.list({ limit: 100 });
  const managed = existing.data.find(
    (c) => c.metadata?.spiralclass_managed === MANAGED_MARKER.spiralclass_managed,
  );

  const livemode = !requireEnv("STRIPE_SECRET_KEY").includes("_test_");
  console.log(`mode:            ${livemode ? "LIVE" : "test"}`);
  console.log(`product:         ${productId}`);
  console.log(`switchable:      ${monthlyPriceId}, ${annualPriceId}`);
  console.log(`founding:        excluded (cohort-gated — checkout only)`);
  console.log(`existing config: ${managed ? managed.id : "none"}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write this configuration.");
    return;
  }

  const result = managed
    ? await stripe.billingPortal.configurations.update(
        managed.id,
        buildPortalConfigurationUpdateParams(ctx),
      )
    : await stripe.billingPortal.configurations.create({
        ...params,
        metadata: { ...MANAGED_MARKER },
      });

  console.log(`\n${managed ? "updated" : "created"}: ${result.id}`);
  console.log(`\nSet this for the environment you just synced:`);
  console.log(`  STRIPE_BILLING_PORTAL_CONFIG_ID=${result.id}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
