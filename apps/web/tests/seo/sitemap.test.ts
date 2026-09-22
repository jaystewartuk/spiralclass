import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPubliclyListed, type ListingGateTeacher } from "@/lib/marketplace-ready";
import { EXCLUDE_TEST_ACCOUNTS_WHERE, isTestAccount } from "@/lib/marketing/test-accounts";
import { HAS_PAYOUT_RAIL_WHERE } from "@/lib/payments/payout-rail-where";

// Pins sitemap.xml: the static marketing routes, the published-teacher
// filter, URL shapes from APP_URL, and that it is served live (force-dynamic)
// rather than baked at build with a stale teacher list.

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { teacher: { findMany } },
}));

const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = ORIGINAL_APP_URL;
  }
});

// APP_URL is read at module load, so import after setting the env var.
async function loadSitemap() {
  const mod = await import("@/app/sitemap");
  return mod;
}

describe("sitemap", () => {
  it("lists the root plus every static marketing/legal page", async () => {
    delete process.env.APP_URL;
    const { default: sitemap } = await loadSitemap();
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain("https://spiralclass.com");
    for (const path of ["/pricing", "/features", "/about", "/help", "/terms", "/privacy-notice"]) {
      expect(urls).toContain(`https://spiralclass.com${path}`);
    }
  });

  it("prioritizes the commercial pages over the legal ones", async () => {
    delete process.env.APP_URL;
    const { default: sitemap } = await loadSitemap();
    const entries = await sitemap();
    const byUrl = new Map(entries.map((e) => [e.url, e]));
    expect(byUrl.get("https://spiralclass.com")?.priority).toBe(1);
    expect(byUrl.get("https://spiralclass.com/pricing")?.priority).toBe(0.9);
    expect(byUrl.get("https://spiralclass.com/terms")?.priority).toBe(0.3);
  });

  it("includes only Marketplace Ready, non-disabled teachers as /b/<slug> entries", async () => {
    delete process.env.APP_URL;
    const updatedAt = new Date("2026-07-01T00:00:00Z");
    findMany.mockResolvedValue([{ bookingSlug: "mira", updatedAt }]);
    const { default: sitemap } = await loadSitemap();
    const entries = await sitemap();

    // The sitemap's `where` is a DB-level
    // translation of isPubliclyListed() (lib/marketplace-ready.ts) — finishing
    // the wizard alone is no longer enough to be listed.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        onboardingCompleteAt: { not: null },
        disabledAt: null,
        photoPath: { not: null },
        bio: { not: null },
        templatesTouchedAt: { not: null },
        availabilityTouchedAt: { not: null },
        // D-113 made the payout rail a relation; D-124 made its bank branch
        // GENERATED from the scheme registry (one arm per pricing currency,
        // naming the schemes that can settle it). Asserted by reference to the
        // exported constant rather than copied literally: a hand-copy of ~50
        // generated arms would be unreadable AND would have to be re-copied
        // every time a country is added, which is exactly the coupling the
        // generation removes. The parity sweep below is what proves this
        // clause agrees with the JS gate.
        ...HAS_PAYOUT_RAIL_WHERE,
        // Fixtures pass every activation signal, so they are excluded by shape.
        ...EXCLUDE_TEST_ACCOUNTS_WHERE,
      },
      select: { bookingSlug: true, updatedAt: true },
    });
    const teacherEntry = entries.find((e) => e.url.endsWith("/b/mira"));
    expect(teacherEntry).toEqual({
      url: "https://spiralclass.com/b/mira",
      lastModified: updatedAt,
      changeFrequency: "weekly",
      priority: 0.8,
    });
  });

  it("never lists noindexed utility surfaces (checkout, auth)", async () => {
    delete process.env.APP_URL;
    const { default: sitemap } = await loadSitemap();
    const urls = (await sitemap()).map((e) => e.url);
    for (const path of ["/sign-in", "/sign-up", "/m", "/r", "/buy"]) {
      expect(urls.some((u) => u.includes(path))).toBe(false);
    }
  });

  it("strips a trailing slash from APP_URL so URLs never double the slash", async () => {
    process.env.APP_URL = "https://preview.spiralclass.com/";
    const { default: sitemap } = await loadSitemap();
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain("https://preview.spiralclass.com/pricing");
    expect(urls.some((u) => u.includes("//pricing"))).toBe(false);
  });

  it("is served live (force-dynamic), not baked at build", async () => {
    delete process.env.APP_URL;
    const mod = await loadSitemap();
    expect(mod.dynamic).toBe("force-dynamic");
  });
});

// ---------------------------------------------------------------------------
// Parity: sitemap `where` ≡ isPubliclyListed()
// ---------------------------------------------------------------------------
// The sitemap's Prisma `where` is a hand-maintained DB-level translation of
// isPubliclyListed() (lib/marketplace-ready.ts) — a JS predicate can't run
// inside a `where`, so the two definitions of "public" are written twice and
// nothing structural keeps them together. sitemap.ts's own comment names this
// as the drift risk.
//
// The literal-shape assertion above does NOT catch that drift: adding a
// seventh signal to isPubliclyListed() leaves the `where` (and that
// assertion) untouched and green, while every teacher's page starts 404ing
// with her URL still advertised in the sitemap. This block closes it by
// evaluating the REAL `where` the route passes to Prisma against the same
// teacher rows isPubliclyListed() sees, over every combination of signals.

type WhereClause = Record<string, unknown>;

function isNotNullOperator(condition: unknown): boolean {
  return (
    typeof condition === "object" &&
    condition !== null &&
    !Array.isArray(condition) &&
    Object.keys(condition).length === 1 &&
    "not" in condition &&
    (condition as { not: unknown }).not === null
  );
}

function isSomeOperator(condition: unknown): condition is { some: WhereClause } {
  return (
    typeof condition === "object" &&
    condition !== null &&
    !Array.isArray(condition) &&
    Object.keys(condition).length === 1 &&
    "some" in condition
  );
}

/**
 * Minimal evaluator for the Prisma `where` dialect the sitemap actually uses:
 * `field: null`, `field: true`, `field: "literal"`, `field: { not: null }`,
 * `relation: { some: {...} }`, and `OR`/`AND` arrays.
 *
 * Deliberately throws on anything else rather than silently passing. If a
 * future change reaches for an operator this doesn't model, the parity test
 * fails loudly and whoever wrote it extends this function — which is the
 * moment to re-check that isPubliclyListed() still agrees. A permissive
 * evaluator here would quietly reintroduce exactly the drift it exists to
 * prevent.
 */
function isInOperator(condition: unknown): condition is { in: readonly string[] } {
  return (
    typeof condition === "object" &&
    condition !== null &&
    !Array.isArray(condition) &&
    Object.keys(condition).length === 1 &&
    "in" in condition &&
    Array.isArray((condition as { in: unknown }).in)
  );
}

function matchesWhere(row: Record<string, unknown>, where: WhereClause): boolean {
  return Object.entries(where).every(([key, condition]) => {
    // `NOT: [...]` — the fixture exclusion (lib/marketing/test-accounts.ts).
    // Prisma treats an array under NOT as "none of these match".
    if (key === "NOT") {
      const subclauses = (Array.isArray(condition) ? condition : [condition]) as WhereClause[];
      return !subclauses.some((sub) => matchesWhere(row, sub));
    }
    if (key === "OR" || key === "AND") {
      if (!Array.isArray(condition)) {
        throw new Error(`sitemap where: ${key} must be an array`);
      }
      const subclauses = condition as WhereClause[];
      return key === "OR"
        ? subclauses.some((sub) => matchesWhere(row, sub))
        : subclauses.every((sub) => matchesWhere(row, sub));
    }
    const value = row[key];
    if (condition === null) return value === null;
    if (typeof condition === "boolean") return value === condition;
    if (typeof condition === "string") return value === condition;
    if (isNotNullOperator(condition)) return value !== null;
    // `schemeId: { in: [...] }` — D-124's SQL gate filters bank accounts by
    // the scheme ids that can settle the teacher's pricing currency, a list
    // generated from the shared registry rather than hand-written.
    if (isInOperator(condition)) {
      return typeof value === "string" && condition.in.includes(value);
    }
    // `bookingSlug: { startsWith }` / `email: { endsWith }` — the fixture
    // exclusion matches on shape so a fixture created later needs no code
    // change.
    if (typeof condition === "object" && condition !== null && "startsWith" in condition) {
      const prefix = (condition as { startsWith: string }).startsWith;
      return typeof value === "string" && value.toLowerCase().startsWith(prefix);
    }
    if (typeof condition === "object" && condition !== null && "endsWith" in condition) {
      const suffix = (condition as { endsWith: string }).endsWith;
      return typeof value === "string" && value.toLowerCase().endsWith(suffix);
    }
    // `payoutInstruments: { some: {...} }` — D-113 moved the payout rail off
    // two teacher columns onto a relation, so the gate's SQL translation now
    // reaches for a relation filter. Evaluated the same way Prisma does: at
    // least one related row satisfies the whole subclause.
    if (isSomeOperator(condition)) {
      if (!Array.isArray(value)) {
        throw new Error(`sitemap where: ${key} { some } needs an array on the row`);
      }
      return (value as Record<string, unknown>[]).some((related) =>
        matchesWhere(related, condition.some),
      );
    }
    throw new Error(
      `sitemap where uses an operator this parity test can't evaluate: ` +
        `${key} → ${JSON.stringify(condition)}. Extend matchesWhere(), and ` +
        `confirm isPubliclyListed() still agrees with the new clause.`,
    );
  });
}

const STAMP = new Date("2026-07-01T00:00:00Z");

// The genuinely distinct payout states after D-113. "enabled but no detail"
// is a real half-configured shape, not a synthetic one — it's what a teacher
// looks like mid-setup.
//
// `speiOnlyNonMxn` is the state the generalization introduced: SPEI settles in
// MXN alone, so a teacher priced in GBP whose only instrument is SPEI cannot
// actually be paid. The gate and its SQL translation both have to agree she
// isn't listed, and this is the row that proves it.
const wiseRow = (handle: string | null) => ({
  kind: "wise" as const,
  enabled: true,
  wiseHandle: handle,
});
const PAYOUT_VARIANTS = {
  none: { stripeChargesEnabled: false, pricingCurrency: "MXN", payoutInstruments: [] },
  stripe: { stripeChargesEnabled: true, pricingCurrency: "MXN", payoutInstruments: [] },
  wise: {
    stripeChargesEnabled: false,
    pricingCurrency: "MXN",
    payoutInstruments: [wiseRow("mira")],
  },
  wiseNoHandle: {
    stripeChargesEnabled: false,
    pricingCurrency: "MXN",
    payoutInstruments: [wiseRow(null)],
  },
  wiseDisabled: {
    stripeChargesEnabled: false,
    pricingCurrency: "MXN",
    payoutInstruments: [{ ...wiseRow("mira"), enabled: false }],
  },
  // D-145 removed the `bank_account` kind, and with it every variant that
  // varied a scheme id: spei, speiPaused, speiNoDetails, speiOnlyNonMxn,
  // unknownScheme, ibanNonMxn and swiftAnyCurrency. They are deleted rather
  // than rewritten as Wise duplicates, because this test's whole claim is that
  // the JS predicate and its SQL translation agree over the REACHABLE states —
  // and a state the application can no longer produce proves nothing about
  // either. Wise settles any currency, so the currency axis they existed to
  // cover no longer has two sides.
} as const;

function everyListingGateTeacher(): Array<{ label: string; teacher: ListingGateTeacher }> {
  const rows: Array<{ label: string; teacher: ListingGateTeacher }> = [];
  for (const onboarded of [true, false]) {
    for (const hasPhoto of [true, false]) {
      for (const hasBio of [true, false]) {
        for (const templatesTouched of [true, false]) {
          for (const availabilityTouched of [true, false]) {
            for (const disabled of [true, false]) {
              for (const [payoutName, payout] of Object.entries(PAYOUT_VARIANTS)) {
                rows.push({
                  label:
                    `onboarded=${onboarded} photo=${hasPhoto} bio=${hasBio} ` +
                    `templates=${templatesTouched} availability=${availabilityTouched} ` +
                    `disabled=${disabled} payout=${payoutName}`,
                  teacher: {
                    onboardingCompleteAt: onboarded ? STAMP : null,
                    disabledAt: disabled ? STAMP : null,
                    photoPath: hasPhoto ? "teachers/mira.jpg" : null,
                    bio: hasBio ? "I teach English." : null,
                    templatesTouchedAt: templatesTouched ? STAMP : null,
                    availabilityTouchedAt: availabilityTouched ? STAMP : null,
                    ...payout,
                  },
                });
              }
            }
          }
        }
      }
    }
  }
  return rows;
}

describe("sitemap listing filter ≡ isPubliclyListed() minus fixtures", () => {
  // The contract gained a second half. The sitemap is no longer a pure
  // translation of isPubliclyListed(): a fixture IS publicly listed — its /b/
  // page must work, that is what it is for — and is deliberately NOT indexed.
  // `test-teacher-mira` and `test-teacher-jay` were live in the production
  // sitemap next to the real teachers until this landed.
  const shouldBeIndexed = (teacher: Parameters<typeof isPubliclyListed>[0]) =>
    isPubliclyListed(teacher) &&
    !isTestAccount({
      bookingSlug: (teacher as { bookingSlug?: string | null }).bookingSlug ?? null,
      email: (teacher as { email?: string | null }).email ?? null,
    });

  async function captureSitemapWhere(): Promise<WhereClause> {
    delete process.env.APP_URL;
    const { default: sitemap } = await loadSitemap();
    await sitemap();
    const call = findMany.mock.calls[0]?.[0] as { where?: WhereClause } | undefined;
    if (!call?.where) throw new Error("sitemap did not query teachers with a `where`");
    return call.where;
  }

  it("agrees on every combination of the activation signals", async () => {
    const where = await captureSitemapWhere();

    const disagreements = everyListingGateTeacher()
      .map(({ label, teacher }) => ({
        label,
        gate: shouldBeIndexed(teacher),
        sitemap: matchesWhere(teacher as unknown as Record<string, unknown>, where),
      }))
      .filter((r) => r.gate !== r.sitemap)
      .map((r) => `${r.label} → shouldBeIndexed=${r.gate}, sitemap=${r.sitemap}`);

    // A non-empty list means a teacher is either 404ing while advertised in
    // the sitemap, or live but invisible to search — the two failure modes
    // this parity check exists to prevent.
    expect(disagreements).toEqual([]);
  });

  it("excludes a fixture that is otherwise fully listable", async () => {
    // The exact shape that was being indexed: every activation signal set, so
    // isPubliclyListed() says yes and the page really does work — and the
    // sitemap says no anyway, purely because of the slug.
    const where = await captureSitemapWhere();
    const listable = everyListingGateTeacher().find(({ teacher }) => isPubliclyListed(teacher));
    if (!listable) throw new Error("no fully listable teacher in the sweep");
    const fixture = { ...listable.teacher, bookingSlug: "test-teacher-mira" };
    expect(isPubliclyListed(fixture)).toBe(true);
    expect(matchesWhere(fixture as unknown as Record<string, unknown>, where)).toBe(false);
  });

  it("covers both outcomes, so the sweep can't pass by matching on nothing", async () => {
    const where = await captureSitemapWhere();
    const verdicts = everyListingGateTeacher().map(({ teacher }) =>
      matchesWhere(teacher as unknown as Record<string, unknown>, where),
    );
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  // Regression: the 2026-07-26 de-listing. Migration
  // 20260725000000_add_teacher_activation_touched_at added the two `*TouchedAt`
  // columns as nullable with no backfill; the same day the listing gate began
  // requiring them. Every teacher who onboarded earlier read as "never
  // touched" and her booking page 404ed with nothing pointing at the cause.
  //
  // This asserts the two definitions AGREE on that state — not that it's
  // listed. Staying unlisted is the intended gate behaviour (an untouched
  // starter-template/availability seed is exactly what it filters out, see
  // lib/starter-templates.ts). The fix is a real save through the onboarding /
  // settings actions, which stamp the columns with genuine intent.
  it("agrees that a pre-touched-at teacher is not listed (2026-07-26 regression)", async () => {
    const where = await captureSitemapWhere();
    const legacyTeacher: ListingGateTeacher = {
      onboardingCompleteAt: STAMP,
      disabledAt: null,
      photoPath: "teachers/mira.jpg",
      bio: "I teach English.",
      templatesTouchedAt: null,
      availabilityTouchedAt: null,
      ...PAYOUT_VARIANTS.wise,
    };
    expect(isPubliclyListed(legacyTeacher)).toBe(false);
    expect(matchesWhere(legacyTeacher as unknown as Record<string, unknown>, where)).toBe(false);
  });
});
