import { describe, expect, it } from "vitest";
import { isTestAccount } from "@/lib/marketing/test-accounts";

/**
 * Keeping fixtures out of the sitemap.
 *
 * The two rows that prompted this — `test-teacher-mira` and `test-teacher-jay` —
 * were live in the production sitemap next to the real teachers, so they were
 * the second and third result a stranger auditing the product would open.
 */
describe("isTestAccount", () => {
  it("excludes the two fixtures that were actually indexed", () => {
    for (const bookingSlug of ["test-teacher-mira", "test-teacher-jay"]) {
      expect(isTestAccount({ bookingSlug, email: "someone@example.org" })).toBe(true);
    }
  });

  it("excludes every reserved prefix, so a new fixture needs no code change", () => {
    for (const bookingSlug of ["seed-teacher-3", "demo-school", "fixture-a", "e2e-run-1"]) {
      expect(isTestAccount({ bookingSlug, email: null })).toBe(true);
    }
  });

  it("excludes RFC 2606 test domains, which no real teacher can receive mail on", () => {
    expect(
      isTestAccount({ bookingSlug: "alicia-moreno", email: "alicia.moreno@spiralclass.test" }),
    ).toBe(true);
    expect(isTestAccount({ bookingSlug: "alicia-moreno", email: "mira@example.com" })).toBe(true);
  });

  it("keeps a real teacher, including one whose name merely contains the word", () => {
    // `.invalid` rather than a plausible address because the personal-data
    // scanner rejects real-looking ones in fixtures — and `.invalid` is not on
    // the reserved list, so it still exercises the "this is a person" path.
    // The rule is a PREFIX, not a substring: a Spanish or French teacher whose
    // slug happens to contain "test" ("contest-prep", "protestant-school") is a
    // person, and dropping her from the sitemap would cost her students.
    for (const bookingSlug of [
      "alicia-moreno",
      "contest-prep",
      "protestant-school",
      "latest-french",
    ]) {
      expect(isTestAccount({ bookingSlug, email: "teacher@real.invalid" })).toBe(false);
    }
  });

  it("is case-insensitive and survives missing data", () => {
    expect(isTestAccount({ bookingSlug: "TEST-Teacher", email: null })).toBe(true);
    expect(isTestAccount({ bookingSlug: null, email: null })).toBe(false);
    expect(isTestAccount({ bookingSlug: null, email: "a@b.TEST" })).toBe(true);
  });
});
