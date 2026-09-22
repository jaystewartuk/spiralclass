import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One question, one answer: how is an hour written?
 *
 * WHY THIS EXISTS. "Leading zero on the hour?" was decided independently at
 * sixteen call sites — eleven `hour: "2-digit"`, four `numeric`, plus the
 * parser — and the product shipped both answers at once: the public checkout
 * rendered a class at "5:00 p.m." while the teacher's own calendar rendered
 * the same class at "05:00 p.m.". Nobody chose that. It is what a formatting
 * decision does when every caller is allowed to make it again.
 *
 * `packages/shared/src/time-format.ts` now decides it once, from the locale.
 * This keeps it decided: a new `hour:` in an Intl options bag is a
 * seventeenth answer, and the fix is `...timeOptionsFor(locale)`.
 *
 * SCOPE is web plus the shared package, which is every client there is.
 */

const ROOTS = [
  join(__dirname, "..", "..", "src"),
  join(__dirname, "..", "..", "..", "..", "packages", "shared", "src"),
];

/**
 * The two files allowed to name an hour style, each for a reason that is not
 * "we forgot".
 */
const ALLOWED = new Map<string, string>([
  [
    "packages/shared/src/time-format.ts",
    "IS the rule — it probes a locale with `hour: numeric` to find out whether that locale prints a meridiem.",
  ],
  [
    "packages/shared/src/calendar-layout.ts",
    "PARSES rather than displays: minutesOfDayInTz pins `hour12: false` and reads the number back out, so its options bag is arithmetic, not typography.",
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative posix path, so the allowlist keys read like real paths. */
function rel(file: string): string {
  const i = file.indexOf("/apps/web/");
  if (i !== -1) return "apps/web/" + file.slice(i + "/apps/web/".length);
  const j = file.indexOf("/packages/shared/");
  if (j !== -1) return "packages/shared/" + file.slice(j + "/packages/shared/".length);
  return file;
}

const files = ROOTS.flatMap((root) => walk(root));

describe("hour formatting is decided in one place", () => {
  it("finds both trees to check", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => rel(f).startsWith("packages/shared/"))).toBe(true);
  });

  it("names an hour style nowhere but the rule and the parser", () => {
    const offenders = files
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => /\bhour:\s*["']/.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((r) => !ALLOWED.has(r));
    expect(
      offenders,
      `These pick an hour style themselves instead of taking the locale's. ` +
        `Spread \`timeOptionsFor(locale)\` from @spiralclass/shared into the ` +
        `Intl options bag, or call \`formatTimeInZone\` when the time is the ` +
        `whole string:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps its own allowlist honest", () => {
    // An allowlist entry is a claim that a file still needs the exemption. If
    // one stops naming an hour at all, the entry is stale and the next reader
    // would take it as licence.
    const stale = [...ALLOWED.keys()].filter((entry) => {
      const file = files.find((f) => rel(f) === entry);
      return !file || !/\bhour:\s*["']/.test(readFileSync(file, "utf8"));
    });
    expect(stale, `Allowlisted files that no longer need it:\n${stale.join("\n")}`).toEqual([]);
  });
});
