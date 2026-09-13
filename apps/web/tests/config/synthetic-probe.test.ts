import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * `scripts/local/synthetic.sh` is the one probe that runs against the LIVE site.
 * Every other place a booking slug appears — the seed, the E2E and a11y suites,
 * Lighthouse, the unit fixtures — runs against a database the seed built.
 *
 * The publication sweep replaced the production teacher's slug everywhere,
 * including here, with the seed's pseudonym `alicia-moreno`. That is right for
 * every other file and wrong for this one: production has no such teacher. The
 * first deploy from this repository (2026-09-13) shipped cleanly, then went red
 * on four probes, all against a 404. Nothing checked, because the probe only
 * runs after a deploy.
 *
 * This cannot ask production which slugs exist. What it can hold is the
 * mistake that happened: the probe's teacher must never be one the seed
 * creates.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

/** `TEACHER_SLUG="${TEACHER_SLUG:-<default>}"` — the slug a bare run probes. */
function probeSlug(): string {
  const match = /^TEACHER_SLUG="\$\{TEACHER_SLUG:-([a-z0-9-]+)\}"$/m.exec(
    read("scripts", "local", "synthetic.sh"),
  );
  expect(
    match,
    "synthetic.sh no longer defaults TEACHER_SLUG in the shape this reads",
  ).not.toBeNull();
  return match![1];
}

/** Every booking slug the seed writes: `bookingSlug: "…"` and each hero's `slug: "…"`. */
function seedSlugs(): Set<string> {
  const seed = read("apps", "web", "scripts", "seed.ts");
  const slugs = [...seed.matchAll(/\b(?:bookingSlug|slug):\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  return new Set(slugs);
}

describe("the production probe targets a real teacher, not a seed fixture", () => {
  it("reads the seed's slugs, so the check below is not vacuous", () => {
    const slugs = seedSlugs();
    expect(slugs.size).toBeGreaterThan(5);
    expect(slugs).toContain("alicia-moreno");
  });

  it("probes a slug the seed does not create", () => {
    const slug = probeSlug();
    expect(
      seedSlugs().has(slug),
      `synthetic.sh probes /b/${slug}, which apps/web/scripts/seed.ts creates. Production has no ` +
        "seed teachers, so every booking-page probe would fail against a 404 after a good deploy.",
    ).toBe(false);
  });
});
