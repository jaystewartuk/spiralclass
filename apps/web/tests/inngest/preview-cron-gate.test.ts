import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The preview deploy must register ZERO cron functions.
//
// Neon's Free plan gives each project 100 CU-hours/month and suspends the
// compute for the rest of the billing period once that's spent — it is not an
// overage charge, it's the database going dark. Its scale-to-zero timer is
// fixed at 5 minutes on that plan, so every cron tick is a DB touch that buys
// 5 minutes of billed compute. A full cron fleet ticking every 5-15 min
// therefore pins a project awake ~24/7 (~182 CU-hours/month, 1.8x the
// allowance). Preview is the half of that spend that bought nothing: no real
// users to remind, no real payments to reconcile, no real push receipts to
// chase. See isPreviewDeployment in src/lib/env.ts.
//
// This reads the registry as SOURCE rather than importing it: pulling in
// lib/inngest/functions/index.ts drags every handler's transitive graph
// (prisma, stripe, storage, email) into a unit test that only needs to know
// which array each function landed in. The naming convention is the anchor —
// every cron in this codebase is declared as `<name>CronFn`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = join(__dirname, "..", "..", "src", "lib", "inngest", "functions");
const INDEX = join(FUNCTIONS_DIR, "index.ts");

// Pulls the identifiers out of an `export const <name> = [ ... ];` array literal.
//
// Comments are stripped BEFORE the split, not after: a comma inside a `//`
// comment in the array body would otherwise cut that comment in two and leave
// its tail glued to the next identifier, silently producing a garbage "member"
// that no assertion below would recognise as either a cron or a stray.
function arrayMembers(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!match) throw new Error(`could not find "export const ${name} = [...]" in index.ts`);
  return match[1]
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// The body of `export function registeredFunctions(isPreview) { ... }`, for the
// spread-placement assertions below — again as source, not by import.
function registeredFunctionsBody(src: string): string {
  const match = src.match(/export function registeredFunctions\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!match) throw new Error('could not find "export function registeredFunctions" in index.ts');
  return match[1].replace(/\/\/.*$/gm, "");
}

const source = readFileSync(INDEX, "utf8");
const eventFunctions = arrayMembers(source, "eventFunctions");
const cronFunctions = arrayMembers(source, "cronFunctions");
const productionOnlyEventFunctions = arrayMembers(source, "productionOnlyEventFunctions");

describe("inngest registry — preview cron gate", () => {
  it("keeps every cron out of the always-on event list", () => {
    const strays = eventFunctions.filter((n) => n.endsWith("CronFn"));
    expect(
      strays,
      `these crons are in eventFunctions, so they would run on the preview deploy ` +
        `and pin its Neon compute awake 24/7: ${strays.join(", ")}`,
    ).toEqual([]);
  });

  it("lists only crons in the preview-gated list", () => {
    const strays = cronFunctions.filter((n) => !n.endsWith("CronFn"));
    expect(
      strays,
      `these are in cronFunctions but aren't crons, so preview would lose them ` +
        `for no compute saving: ${strays.join(", ")}`,
    ).toEqual([]);
  });

  it("registers every cron module in the repo (no cron silently unregistered)", () => {
    // A cron file that nobody imports is dead weight that reads as scheduled.
    const declared = new Set([
      ...eventFunctions,
      ...productionOnlyEventFunctions,
      ...cronFunctions,
    ]);
    const onDisk = readdirSync(FUNCTIONS_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts"))
      .flatMap((f) => {
        const exported = readFileSync(join(FUNCTIONS_DIR, f), "utf8").match(
          /export const (\w+CronFn)\b/g,
        );
        return (exported ?? []).map((m) => m.replace("export const ", ""));
      });

    const unregistered = onDisk.filter((n) => !declared.has(n));
    expect(
      unregistered,
      `these cron functions are declared but never registered: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("drops crons in preview and keeps them everywhere else", () => {
    // Mirrors registeredFunctions()'s ternary against the parsed lists, so the
    // counts stay honest as functions are added on either side.
    const preview = eventFunctions;
    const production = [...eventFunctions, ...productionOnlyEventFunctions, ...cronFunctions];

    expect(preview.some((n) => n.endsWith("CronFn"))).toBe(false);
    expect(production.length).toBe(
      eventFunctions.length + productionOnlyEventFunctions.length + cronFunctions.length,
    );
    expect(cronFunctions.length).toBeGreaterThan(0);
  });
});

// The reminder wake chain has an event-driven starter, on-booking-created.ts
// (D-115 addendum, 2026-08-16): every `booking.created` re-runs the reminder
// scan so a class booked between two hourly ticks still gets its 1h/15m legs
// on time. It is not a cron, so nothing above would catch it landing in
// eventFunctions — but on preview it would start the chain from every Maestro
// booking, and preview keeps its crons off precisely so no reminder ever fires
// there. These pin it to the production-only list, by name and by placement in
// registeredFunctions()'s ternary, so a future edit can't quietly move it.
describe("inngest registry — production-only event functions", () => {
  it("declares productionOnlyEventFunctions with the booking-created chain starter", () => {
    expect(productionOnlyEventFunctions).toContain("onBookingCreatedFn");
  });

  it("holds only event functions, never a cron (crons have their own list)", () => {
    const strays = productionOnlyEventFunctions.filter((n) => n.endsWith("CronFn"));
    expect(
      strays,
      `these crons are in productionOnlyEventFunctions instead of cronFunctions: ` +
        strays.join(", "),
    ).toEqual([]);
  });

  it("keeps onBookingCreatedFn out of the always-on event list", () => {
    expect(
      eventFunctions,
      "onBookingCreatedFn is in eventFunctions, so preview would arm reminder wakes " +
        "for every Maestro booking",
    ).not.toContain("onBookingCreatedFn");
  });

  it("never lists a function in both the always-on and the production-only list", () => {
    const both = productionOnlyEventFunctions.filter((n) => eventFunctions.includes(n));
    expect(both).toEqual([]);
  });

  it("spreads productionOnlyEventFunctions only in the non-preview branch of registeredFunctions", () => {
    const body = registeredFunctionsBody(source);
    const [previewBranch, productionBranch] = body.split(":");
    // A ternary `isPreview ? <preview> : <production>` — exactly one `?` and
    // one `:`, so the split above is unambiguous.
    expect(body.split("?")).toHaveLength(2);
    expect(productionBranch, "registeredFunctions body must be a single ternary").toBeDefined();

    expect(previewBranch).toContain("eventFunctions");
    expect(previewBranch).not.toContain("productionOnlyEventFunctions");
    expect(previewBranch).not.toContain("cronFunctions");

    expect(productionBranch).toContain("...eventFunctions");
    expect(productionBranch).toContain("...productionOnlyEventFunctions");
    expect(productionBranch).toContain("...cronFunctions");
  });
});
