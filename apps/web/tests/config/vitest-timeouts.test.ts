import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every vitest project raises the default test timeout.
 *
 * WHY THIS IS A TEST AND NOT JUST A CONFIG LINE. Vitest's default is 5s, and
 * a project that simply omits `testTimeout` gets it silently — there is no
 * warning, and the omission looks identical to a deliberate choice. That is
 * how the integration project ended up on the default while doing the slowest
 * work in the repo (real Postgres, sequential, `truncateAll` across ~74 tables
 * per test), and the unit project — whose cost is module loading — carried a
 * 20s ceiling with a paragraph explaining why it needed one.
 *
 * The failure it produces is the expensive kind: not a wrong answer, a
 * borderline one. On 2026-09-01 `tests/marketing/profile.integration.test.ts`
 * took 5,160ms against the 5,000ms cap and failed a promote gate; three
 * re-runs did it in 287-314ms. A red gate blocks a deploy, so the cost was a
 * full 20-40 minute cycle and the machine lock, and the lesson it teaches is
 * to re-run rather than read — which is exactly what the unit project's own
 * comment warned about, in the file that already had the fix.
 *
 * So this asserts the property across ALL projects rather than restating one
 * number, and a project added later is covered the day it is added.
 */

// The projects live in vitest.config.ts under `test.projects`. They were in
// vitest.workspace.ts until the vitest 5 bump, which removed that file and
// `defineWorkspace` with it — the split itself is unchanged.
const CONFIG = join(__dirname, "..", "..", "vitest.config.ts");

// Vitest's own default, and the floor this guard exists to keep everything off.
const VITEST_DEFAULT_TIMEOUT_MS = 5_000;

/** `name: "unit"` / `name: "integration"` — the projects declared in the config. */
function projectNames(source: string): string[] {
  return [...source.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The `testTimeout` / `hookTimeout` values declared after each project's
 * `name:`, up to the next project's. Underscore separators are stripped, so
 * `20_000` reads as 20000.
 */
function timeoutsByProject(source: string): Record<string, { test?: number; hook?: number }> {
  const out: Record<string, { test?: number; hook?: number }> = {};
  const blocks = source.split(/name:\s*"/).slice(1);
  for (const block of blocks) {
    const name = block.slice(0, block.indexOf('"'));
    const read = (key: string) => {
      const m = block.match(new RegExp(`${key}:\\s*([\\d_]+)`));
      return m ? Number(m[1].replace(/_/g, "")) : undefined;
    };
    out[name] = { test: read("testTimeout"), hook: read("hookTimeout") };
  }
  return out;
}

describe("vitest project timeouts", () => {
  const source = readFileSync(CONFIG, "utf8");

  it("declares the projects this guard expects to find", () => {
    // If the project list is restructured, fail here rather than passing
    // vacuously over zero projects.
    expect(projectNames(source)).toEqual(expect.arrayContaining(["unit", "integration"]));
  });

  it("raises every project above vitest's 5s default", () => {
    const timeouts = timeoutsByProject(source);
    const offenders = Object.entries(timeouts)
      .filter(([, v]) => (v.test ?? VITEST_DEFAULT_TIMEOUT_MS) <= VITEST_DEFAULT_TIMEOUT_MS)
      .map(([name]) => name);
    expect(
      offenders,
      `These vitest projects run at the 5s default. An omitted testTimeout is\n` +
        `indistinguishable from a chosen one, and on a real DB it fails a gate\n` +
        `on 160ms of clock rather than on behaviour:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every project's ceiling low enough that a real hang still fails", () => {
    // 20s is the number both projects state. The point of asserting a ceiling
    // at all is that "raise the timeout" must not become the reflex fix for a
    // test that genuinely never finishes.
    for (const [name, v] of Object.entries(timeoutsByProject(source))) {
      if (v.test === undefined) continue;
      expect(v.test, `${name}: timeout is high enough to hide a hang`).toBeLessThanOrEqual(30_000);
    }
  });

  it("gives hooks the same budget as tests", () => {
    // The integration suite's slowest step is a beforeEach `truncateAll`, so a
    // raised testTimeout with a default hookTimeout would leave the actual
    // bottleneck on 5s — fixing the symptom and not the cause.
    for (const [name, v] of Object.entries(timeoutsByProject(source))) {
      if (v.test === undefined) continue;
      expect(v.hook, `${name}: hookTimeout must match testTimeout`).toBe(v.test);
    }
  });
});
