// Lightweight ambassador referral attribution — NOT the deferred referral
// engine (no discount codes, no credit ledger; see docs/features/referrals-discounts.md). We only
// capture WHICH ambassador sent a teacher, so the commission report can
// attribute their paid subscription invoices.
//
// Flow (mirrors the attribution capture in docs/features/referrals-discounts.md):
//   1. A teacher arrives via an onboarding/signup link carrying `?ref=CODE`.
//   2. Middleware stamps the code into a first-party cookie (REFERRAL_COOKIE).
//   3. At lazy teacher-create (lib/auth.ts), the cookie is read once and
//      persisted to teachers.referral_source. The cookie is then irrelevant.
//
// Codes are opaque ambassador identifiers (e.g. "alicia-moreno"); the commission
// report groups by this exact string.

export const REFERRAL_COOKIE = "ap_ref";
export const REFERRAL_QUERY_PARAM = "ref";

// 30 days — long enough to survive an email-link → signup gap, short enough to
// not mis-attribute a much later organic return.
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Normalize an incoming ref code: trim, lowercase, cap length, allow only a
// safe slug charset. Returns null when nothing usable remains.
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}
