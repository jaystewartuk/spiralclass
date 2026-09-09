/**
 * Which teacher rows are fixtures rather than people.
 *
 * The production sitemap listed `test-teacher-mira` and `test-teacher-jay`
 * alongside the real teachers, so both were indexable and both were the
 * second and third result a stranger auditing the product would open. They pass
 * every "is this teacher publicly listed" check, because they were built to.
 *
 * Identified by shape rather than by an allowlist of known slugs: a new fixture
 * created next month should be excluded without anyone remembering to add it
 * here. Reserved prefixes and the RFC 2606 `.test` TLD are both conventions
 * nobody uses for a real booking page.
 */

export const RESERVED_SLUG_PREFIXES = ["test-", "seed-", "demo-", "fixture-", "e2e-"] as const;

/** RFC 2606 reserves `.test`; the seed script uses it, and no real teacher can
 * receive mail there. `example.com` is reserved by the same RFC. */
export const RESERVED_EMAIL_SUFFIXES = [".test", "@example.com"] as const;

/**
 * The same rule as a Prisma `where` fragment, so the sitemap can filter in SQL
 * and never select an email at all.
 *
 * Built from the constants above rather than restated, because two copies of
 * this rule would drift and the drift would be invisible — the sitemap would
 * quietly start listing fixtures again and nothing would fail.
 *
 * Selecting the email to filter in JS was the first version, and the personal
 * data ratchet was right to reject it: a public, unauthenticated route has no
 * business pulling addresses out of the database to throw them away.
 */
export const EXCLUDE_TEST_ACCOUNTS_WHERE = {
  NOT: [
    ...RESERVED_SLUG_PREFIXES.map((prefix) => ({ bookingSlug: { startsWith: prefix } })),
    ...RESERVED_EMAIL_SUFFIXES.map((suffix) => ({ email: { endsWith: suffix } })),
  ],
};

export function isTestAccount({
  bookingSlug,
  email,
}: {
  bookingSlug: string | null;
  email: string | null;
}): boolean {
  const slug = bookingSlug?.toLowerCase() ?? "";
  if (RESERVED_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) return true;
  // RFC 2606 reserves `.test`; the seed script uses it, and no real teacher can
  // receive mail there.
  const address = email?.toLowerCase() ?? "";
  return address !== "" && RESERVED_EMAIL_SUFFIXES.some((suffix) => address.endsWith(suffix));
}
