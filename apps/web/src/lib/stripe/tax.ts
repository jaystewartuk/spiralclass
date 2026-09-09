import { serverEnv } from "@/lib/env";

// VAT/GST switch (global-launch item 7). It governs two things, and since
// D-144 they are no longer the same on both rails:
//
//   * Whether Stripe *computes and collects* tax (`automatic_tax[enabled]`).
//     Defaults OFF on both rails: it has prerequisites outside the codebase
//     that the flag does not enforce — never a code default.
//   * On the STUDENT rail only, whether the buyer's billing address is
//     `required` at checkout. This flag used to be irrelevant to that — the
//     address was collected unconditionally, "capture-now, enable-later", so
//     that flipping the flag needed no backfill. D-144 ended that on the
//     student rail: five address fields on the highest-abandonment screen in
//     the product is a real, per-student conversion cost, and it was being paid
//     for a registration that does not exist yet. With the flag off Stripe now
//     collects only what the payment method itself needs.
//   * The TEACHER's own subscription checkout is unchanged and still collects a
//     full address always — that is the platform's own sale, where the address
//     is a billing record rather than readiness.
//
// The consequence to know: student payments taken while this flag is off keep a
// PARTIAL address (often just country + postcode) or none, so flipping the flag
// on cannot retroactively complete them. That is survivable because tax is
// computed from the address collected at the time of the charge — a past sale
// is not taxed by a later registration — but it does mean the pre-flag rows are
// thinner than the original design intended.
//
// Mirrors the other kill-switch env flags (LIVE_CAPTIONS_ENABLED,
// FIELD_ENCRYPTION_REQUIRED): "1"/"true" = on.
export function stripeTaxEnabled(): boolean {
  const v = serverEnv().STRIPE_TAX_ENABLED;
  return v === "1" || v === "true";
}
