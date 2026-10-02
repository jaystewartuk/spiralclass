/**
 * Which accounts are tests rather than people — the ONE definition (D-192).
 *
 * Two ways a row is a test account, and both count everywhere:
 *
 *   1. RECORDED: `testAccount` on `Teacher` / `Student`, set by an operator in
 *      the admin console (audited). This is how the operator's own test
 *      teacher and test students are marked — including a test student inside
 *      a real teacher's roster, which used to sit in her figures: one teacher
 *      was told 126 classes were paid in advance, 100 of them a test account's.
 *   2. BY SHAPE (below): seed and fixture rows, recognised by slug and email,
 *      so a fixture made next month is excluded without anyone flagging it.
 *
 * Every exclusion reads from here, because a rule restated at each call site
 * is one that drifts (D-142 made the same point about the demo).
 *
 * --- The original note, on the shape rule ---
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
    { testAccount: true },
    ...RESERVED_SLUG_PREFIXES.map((prefix) => ({ bookingSlug: { startsWith: prefix } })),
    ...RESERVED_EMAIL_SUFFIXES.map((suffix) => ({ email: { endsWith: suffix } })),
  ],
};

/** A teacher or student row the operator has not marked as a test account. */
export const NOT_TEST_ACCOUNT = { testAccount: false } as const;

/**
 * The `where` fragment that keeps test STUDENTS out of one teacher's figures —
 * for a query on packages, bookings or payments-through-package.
 *
 * Empty for a test teacher: her account is the operator's sandbox, and its
 * whole point is to show what a teacher would see, test students included.
 */
export function realStudentsOf(teacher: { testAccount: boolean }) {
  return teacher.testAccount ? {} : { student: NOT_TEST_ACCOUNT };
}

/**
 * The `where` fragment for a platform roll-up over packages (or anything with
 * a `teacher` and a `student`): neither side a recorded test account.
 * Cross-tenant on purpose — callers say so with `// tenancy-exempt`.
 */
export const REAL_PACKAGE_WHERE = {
  teacher: NOT_TEST_ACCOUNT,
  student: NOT_TEST_ACCOUNT,
} as const;

export function isTestAccount({
  bookingSlug,
  email,
  testAccount = false,
}: {
  bookingSlug: string | null;
  email: string | null;
  testAccount?: boolean;
}): boolean {
  if (testAccount) return true;
  const slug = bookingSlug?.toLowerCase() ?? "";
  if (RESERVED_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) return true;
  // RFC 2606 reserves `.test`; the seed script uses it, and no real teacher can
  // receive mail there.
  const address = email?.toLowerCase() ?? "";
  return address !== "" && RESERVED_EMAIL_SUFFIXES.some((suffix) => address.endsWith(suffix));
}
