/**
 * Fragments on /terms that other surfaces deep-link to.
 *
 * A fragment never reaches the server, so no redirect can rescue one: if a
 * link points at an id the page no longer carries, the browser silently
 * scrolls to the top of a long legal document and the reader is left to find
 * the clause themselves. That failure is invisible to every check that only
 * looks at status codes.
 *
 * So the ids live here, one definition, imported by both the page that renders
 * them and everything that builds a link to them, and pinned by
 * tests/seo/terms-anchors.test.ts.
 */

/** The cancellation and refunds clause. Carried by both language variants. */
export const CANCELLATION_POLICY_ANCHOR = "cancellation-policy";

/**
 * What that clause was addressed as before, still rendered as an empty target.
 *
 * Cancellation and deduction emails carry it, and those are already in
 * people's inboxes where nobody can edit them. New links use
 * `CANCELLATION_POLICY_ANCHOR`; this one only has to keep working.
 */
export const LEGACY_CANCELLATION_ANCHOR = "cancelaciones";

/** `/terms` with the cancellation clause addressed, in the reader's language. */
export function cancellationPolicyPath(spanish: boolean): string {
  return spanish
    ? `/terms?lang=es#${CANCELLATION_POLICY_ANCHOR}`
    : `/terms#${CANCELLATION_POLICY_ANCHOR}`;
}
