import { describe, expect, it } from "vitest";
import {
  StripeApiError,
  isStripeAccountUnreachableError,
  isStripeConnectNotEnabledError,
} from "./client";

// The teacher row can carry a `stripe_account_id` this platform cannot act on.
// Accounts v2 has no OAuth, so a platform can only ever use accounts it created
// itself (D-143, #946); anything else — the teacher's own pre-existing account,
// an id copied between environments, one minted under the pre-D-58 Mexican
// entity — 400s with resource_missing on every call that passes it.
//
// The real instance: acct_1ExampleTeacher0 on POST /v1/account_sessions, which
// wedged /settings/payments for the teacher whose row held it (Sentry
// AGENDAPROFE-31, 12 events on 2026-08-31). Recognising it matters because the
// response must NOT be to mint a replacement: account creation under D-143 is
// irreversible (#948), so a "self-healing" retry manufactures permanent orphans.
describe("isStripeAccountUnreachableError", () => {
  // Verbatim from the Sentry event, including Stripe's spacing.
  const accountSessionsBody = JSON.stringify({
    code: "resource_missing",
    doc_url: "https://stripe.com/docs/error-codes/resource-missing",
    message: "No such account: 'acct_1ExampleTeacher0'",
    param: "account",
  });

  it("matches the production account_sessions failure", () => {
    const err = new StripeApiError(400, accountSessionsBody, "/v1/account_sessions");
    expect(isStripeAccountUnreachableError(err)).toBe(true);
  });

  it("matches the same condition from account_links", () => {
    // The redirect fallback (startStripeConnect) hits a different endpoint with
    // the same bad id, so the predicate keys off the error, not the path.
    const err = new StripeApiError(400, accountSessionsBody, "/v1/account_links");
    expect(isStripeAccountUnreachableError(err)).toBe(true);
  });

  it("matches Stripe's pretty-printed spacing too", () => {
    const err = new StripeApiError(
      400,
      '{\n  "code": "resource_missing",\n  "param": "account",\n  "message": "No such account"\n}',
      "/v1/account_sessions",
    );
    expect(isStripeAccountUnreachableError(err)).toBe(true);
  });

  it("matches account_invalid", () => {
    const err = new StripeApiError(
      403,
      JSON.stringify({ code: "account_invalid", param: "account", message: "No such account" }),
      "/v1/account_sessions",
    );
    expect(isStripeAccountUnreachableError(err)).toBe(true);
  });

  // The narrowing that keeps this from swallowing unrelated failures. A
  // resource_missing on some other param is a different bug and must keep
  // reaching Sentry as an unhandled error rather than being reported to the
  // teacher as a broken Stripe link.
  it("ignores resource_missing on a different param", () => {
    const err = new StripeApiError(
      400,
      JSON.stringify({
        code: "resource_missing",
        param: "price",
        message: "No such price: 'price_123'",
      }),
      "/v1/checkout/sessions",
    );
    expect(isStripeAccountUnreachableError(err)).toBe(false);
  });

  it("ignores a 5xx, which is Stripe being down rather than the id being bad", () => {
    const err = new StripeApiError(503, accountSessionsBody, "/v1/account_sessions");
    expect(isStripeAccountUnreachableError(err)).toBe(false);
  });

  it("ignores non-Stripe errors", () => {
    expect(isStripeAccountUnreachableError(new Error("boom"))).toBe(false);
    expect(isStripeAccountUnreachableError(null)).toBe(false);
    expect(isStripeAccountUnreachableError(undefined)).toBe(false);
  });

  // The two predicates describe different operator problems — one teacher's id
  // is unusable vs. the whole platform isn't onboarded — and must not overlap,
  // because they route to different copy.
  it("does not overlap with isStripeConnectNotEnabledError", () => {
    const notEnabled = new StripeApiError(
      400,
      "Only Stripe accounts that have signed up for Connect can create accounts",
      "/v2/core/accounts",
    );
    expect(isStripeConnectNotEnabledError(notEnabled)).toBe(true);
    expect(isStripeAccountUnreachableError(notEnabled)).toBe(false);

    const unreachable = new StripeApiError(400, accountSessionsBody, "/v1/account_sessions");
    expect(isStripeConnectNotEnabledError(unreachable)).toBe(false);
  });
});
