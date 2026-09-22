import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// Locks the settings behind the 2026-08-26 production outage.
//
// What happened: the `spiralclass` machine ran shared-cpu-1x/512mb. It never
// OOM-killed, so no restart event and no alert ever fired — it simply sat at
// the memory ceiling GC-thrashing. /proc/meminfo on the live machine read
// MemFree 6MB, SwapTotal 0, Committed_AS 534MB against MemTotal 470MB: the app
// had committed more memory than the box physically had. Thrashing stalled the
// event loop past the 8s health-check timeout, the check flapped every ~20-40s,
// and with min_machines_running = 1 Fly's proxy had no healthy candidate and
// served 503 for every request for hours.
//
// Each assertion here is one thing that, if quietly reverted, reproduces it.
// The memory floor especially: `fly scale vm` is a LIVE override that a
// `pnpm promote` resets from this file, so a hand-scaled machine silently
// returns to the outage config on the next deploy. That is the failure mode
// this file exists to prevent — nothing else in the repo would notice.

const FLY_PRODUCTION_TOML = resolve(REPO_ROOT, "fly.production.toml");
const PRODUCTION_RUNTIME_ENV = resolve(REPO_ROOT, "config/env/production.runtime.env");
const NEXT_CONFIG = resolve(REPO_ROOT, "apps/web/next.config.ts");
const TABLET_SIDEBAR = resolve(REPO_ROOT, "apps/web/src/components/tablet-sidebar-nav.tsx");

const read = (p: string) => readFileSync(p, "utf8");

/** Parses `memory = '1024mb'` / `'2gb'` from a fly toml into megabytes. */
function parseMemoryMb(toml: string): number {
  const match = /^\s*memory\s*=\s*['"](\d+)\s*(mb|gb)['"]/im.exec(toml);
  if (!match) throw new Error("no `memory` key found in fly.production.toml [[vm]]");
  const value = Number(match[1]);
  return match[2].toLowerCase() === "gb" ? value * 1024 : value;
}

describe("production VM memory", () => {
  it("provisions at least 1024mb", () => {
    expect(
      parseMemoryMb(read(FLY_PRODUCTION_TOML)),
      "fly.production.toml is back under 1024mb. Measured demand on the live app is " +
        "~540MB committed, so 512mb cannot cover it — that config caused a multi-hour " +
        "503 outage on 2026-08-26 and did so WITHOUT an OOM kill, so nothing alerted.",
    ).toBeGreaterThanOrEqual(1024);
  });

  it("records why, so the next cost pass has the evidence in front of it", () => {
    // The 2 -> 1 machine drop was a reasonable cost decision made without this
    // data. Keeping the numbers next to the setting is what makes the next such
    // decision an informed one rather than a repeat.
    expect(read(FLY_PRODUCTION_TOML)).toMatch(/Committed_AS/);
  });
});

describe("production feature-flag documentation", () => {
  // The header comment in fly.production.toml claimed the legal-gated flags were
  // OFF in production for over a month after D-94 turned them on. A comment that
  // contradicts the file it summarizes is worse than no comment: it was read as
  // "that vendor isn't even on in prod" while diagnosing the outage.
  const FLAGS = ["LESSON_INSIGHTS_TRANSCRIPTION", "LIVE_CAPTIONS", "CLASS_RECORDING"] as const;

  it.each(FLAGS)("does not describe %s as off while production enables it", (flag) => {
    const enabled = new RegExp(`^\\s*${flag}_ENABLED\\s*=\\s*1\\s*$`, "m").test(
      read(PRODUCTION_RUNTIME_ENV),
    );
    if (!enabled) return; // genuinely off — nothing to contradict.

    const toml = read(FLY_PRODUCTION_TOML);
    const claimsOff = new RegExp(`${flag}[^\\n]*\\n?[^\\n]*\\bOFF for production\\b`).test(toml);
    expect(
      claimsOff,
      `config/env/production.runtime.env sets ${flag}_ENABLED=1, but fly.production.toml ` +
        `still describes it as "OFF for production". Update the comment — production.runtime.env ` +
        `is the authoritative file and carries the D-94 override record.`,
    ).toBe(false);
  });
});

describe("image optimizer memory footprint", () => {
  // /_next/image runs sharp IN-PROCESS on the same machine as SSR. At Next's
  // 60s default every optimized R2 photo was re-fetched and re-resized once a
  // minute per (src, w, q) — a recurring native allocation on a box with 6MB
  // free, and the source of the `upstream image response timed out` 504s.
  it("sets a minimumCacheTTL far above the 60s default", () => {
    const config = read(NEXT_CONFIG);
    const match = /minimumCacheTTL:\s*([0-9*\s]+),/.exec(config);
    expect(match, "next.config.ts no longer sets images.minimumCacheTTL").not.toBeNull();

    // The value is written as an arithmetic expression for readability
    // (31 * 24 * 60 * 60), so evaluate the digits rather than pinning the text.
    const seconds = match![1]
      .split("*")
      .map((n) => Number(n.trim()))
      .reduce((a, b) => a * b, 1);
    expect(seconds).toBeGreaterThanOrEqual(24 * 60 * 60);
  });

  it("keeps the ?v= cache-buster that makes a long TTL safe", () => {
    // A long minimumCacheTTL is only correct because every public R2 URL
    // carries a version. Drop the buster and a re-uploaded photo goes stale for
    // a month instead of a minute.
    expect(read(resolve(REPO_ROOT, "apps/web/src/lib/storage/r2-public-url.ts"))).toMatch(
      /\?v=\$\{version\}/,
    );
  });
});

describe("tablet sidebar prefetching", () => {
  it("disables prefetch on its links", () => {
    // This rail renders ~24 links at once and is md:block, so at 768-1023px all
    // of them are visible simultaneously. At Next's default that fires ~24 RSC
    // prefetches per page load, each re-running the (app) layout — ~24
    // concurrent React renders as a single allocation spike.
    expect(
      read(TABLET_SIDEBAR),
      "tablet-sidebar-nav.tsx no longer passes prefetch={false}. Unlike the phone " +
        "drawer and the desktop dropdowns, this rail renders every nav link at once.",
    ).toMatch(/prefetch=\{false\}/);
  });
});
