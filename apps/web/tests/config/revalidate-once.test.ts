import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// A server action may revalidate AT MOST ONE PATH.
//
// This is the guard for the bug in D-174, which is invisible to every other
// check in this repo: it type-checks, lints, builds, passes unit tests, and
// only appears in a PRODUCTION build (`pnpm dev` never shows it). A second
// `revalidatePath` in one action — even the same path twice, even layout-scoped
// — makes the client discard the entire action response. `useActionState` never
// receives the returned state, the page never refreshes, and on next 15.5.25
// the transition never commits: the submit button sits disabled on "Saving…"
// forever and every link on the page stops working until a manual reload.
//
// The write still succeeds. That is what makes it expensive — the teacher sees
// a dead button, assumes nothing saved, and clicks again, so the damage shows
// up as duplicate rows in an audit log rather than as an error anyone can see.
//
// Enforced statically rather than at runtime because the failure is per-request
// and silent: there is nothing to throw and nobody to tell. The rule is a
// property of the source, so the source is where it is checked.
//
// If you need a second surface to refresh: you almost certainly don't. No route
// in this app is prerendered (`next build` marks every one `ƒ`), so there is no
// Full Route Cache to invalidate, and `staleTimes.dynamic` is 0 — the other
// page refetches when the user navigates to it.
//
// The rule is ONE CALL SITE per function, not "one call at runtime". A pair of
// mutually exclusive branches only ever revalidates once, but proving that from
// the source needs a control-flow analysis this guard deliberately does not do —
// and a reader has to do the same proof every time they touch the function.
// Compute the path and pass it to one call instead:
//
//   revalidateAfterAction(bookingId ? `/dashboard/classes/${bookingId}` : "/dashboard/materials");
//
// The one exception the counter tolerates is an early `return` between two call
// sites, which makes the second unreachable from the first.

const WEB_SRC = resolve(REPO_ROOT, "apps/web/src");

/** Every module a server action's revalidation can reach. */
const SCANNED_GLOBS = ["app/actions/**/*.ts", "lib/**/revalidate.ts"];

/** The wrapper itself is the one place a raw `revalidatePath` is allowed. */
const RAW_CALL_ALLOWED = new Set(["lib/revalidate.ts"]);

type Offence = { file: string; fn: string; count: number };

function scannedFiles(): string[] {
  return SCANNED_GLOBS.flatMap((g) => globSync(g, { cwd: WEB_SRC })).sort();
}

/** Split a module into its top-level exported functions, crudely but stably. */
function exportedFunctions(src: string): { name: string; body: string }[] {
  const parts = src.split(/\nexport (?:async )?function /);
  return parts.slice(1).map((part) => ({
    name: part.slice(0, part.indexOf("(")).trim(),
    body: part,
  }));
}

/**
 * Call sites that can still be reached once an earlier one has run. A `return`
 * between two of them ends the function, so the pair can never both fire; every
 * other arrangement counts.
 */
function countReachableRevalidations(body: string): number {
  const tokens = [...body.matchAll(/\breturn\b|\brevalidate(?:Path|AfterAction)\s*\(/g)];
  let reachable = 0;
  let sinceReturn = 0;
  for (const t of tokens) {
    if (t[0].startsWith("return")) sinceReturn = 0;
    else sinceReturn += 1;
    reachable = Math.max(reachable, sinceReturn);
  }
  return reachable;
}

describe("server actions revalidate at most one path", () => {
  it("scans a non-trivial number of files (the glob still resolves)", () => {
    expect(scannedFiles().length).toBeGreaterThan(20);
  });

  it("no exported function revalidates more than once", () => {
    const offences: Offence[] = [];
    for (const file of scannedFiles()) {
      // The wrapper forwards to `revalidatePath` from two arms of a scope
      // check; it is the one function whose job is to make the single call.
      if (RAW_CALL_ALLOWED.has(file)) continue;
      const src = readFileSync(resolve(WEB_SRC, file), "utf8");
      if (!src.includes("revalidate")) continue;
      for (const fn of exportedFunctions(src)) {
        const count = countReachableRevalidations(fn.body);
        if (count > 1) offences.push({ file, fn: fn.name, count });
      }
    }
    expect(
      offences,
      `These actions revalidate more than one path, which makes the client throw\n` +
        `away the action's response (see apps/web/src/lib/revalidate.ts and D-174).\n` +
        `Keep the path of the page the action is invoked from and drop the rest:\n` +
        offences.map((o) => `  ${o.file} :: ${o.fn} (${o.count} calls)`).join("\n"),
    ).toEqual([]);
  });

  it("actions call revalidateAfterAction, never revalidatePath directly", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      if (RAW_CALL_ALLOWED.has(file)) continue;
      const src = readFileSync(resolve(WEB_SRC, file), "utf8");
      if (/\brevalidatePath\s*\(/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `Import revalidateAfterAction from "@/lib/revalidate" instead of calling\n` +
        `revalidatePath directly — the wrapper is where the one-call rule is\n` +
        `documented, and routing every action through it is what makes the rule\n` +
        `greppable. Offenders:\n` +
        offenders.map((f) => `  ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("the wrapper still calls through to next/cache", () => {
    const src = readFileSync(resolve(WEB_SRC, "lib/revalidate.ts"), "utf8");
    expect(src).toContain('from "next/cache"');
    expect(src).toMatch(/export function revalidateAfterAction/);
  });
});

describe("scan coverage", () => {
  it("reports the files it scanned relative to apps/web/src", () => {
    // Cheap tripwire: if someone moves the actions tree, the glob above goes
    // quiet and this suite would pass while checking nothing.
    const files = scannedFiles();
    expect(files.some((f) => f.startsWith("app/actions/"))).toBe(true);
    expect(relative(WEB_SRC, resolve(WEB_SRC, files[0]!))).toBe(files[0]);
  });
});
