import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import tailwindConfig from "../../tailwind.config";
import { CONTAINER_MAX_WIDTH, DESKTOP_MIN_WIDTH, SCREENS } from "../../src/lib/breakpoints";

// The scale in src/lib/breakpoints.ts only means anything if every consumer
// actually reads it. Four of them can drift away silently — with a green build,
// green types, and green tests — so each gets a guard here:
//
//   1. tailwind.config.ts, which could be hand-typed back to literals, or have
//      `screens` moved under `extend` (which MERGES with Tailwind's defaults
//      and would quietly resurrect sm:640 alongside sm:1281).
//   2. globals.css, whose two raw media queries are the other half of switches
//      whose first half is a `md:` utility. A pixel literal there is how
//      `.table-stack` and TableShell's frame end up disagreeing about what
//      "below md" means, leaving a band of widths that draws a desktop table
//      frame around already-stacked cards.
//   3. The Playwright configs, whose "Desktop Chrome" preset is 1280×720 —
//      one pixel below the threshold. Unpinned, every browser spec renders the
//      MOBILE layout and still passes, so desktop coverage disappears without
//      a single red test.
//   4. `theme.screens` is a REPLACEMENT, not an extension: a prefix used in
//      src/ but missing from the scale compiles to nothing at all.

const WEB_ROOT = resolve(__dirname, "../..");
const SRC = join(WEB_ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(SRC);
const read = (file: string) => readFileSync(file, "utf8");

describe("tailwind config consumes the scale", () => {
  const theme = tailwindConfig.theme as Record<string, unknown>;

  it("feeds theme.screens from src/lib/breakpoints rather than literals", () => {
    expect(theme.screens).toEqual(SCREENS);
  });

  it("replaces the default scale instead of extending it", () => {
    // `extend.screens` merges, so sm would resolve to 640px again and every
    // tablet would silently go back to the desktop layout.
    const extend = (theme.extend ?? {}) as Record<string, unknown>;
    expect(extend.screens).toBeUndefined();
  });

  it("pins the container ceiling to CONTAINER_MAX_WIDTH", () => {
    const container = theme.container as { screens?: Record<string, string> };
    expect(Object.values(container.screens ?? {})).toEqual([CONTAINER_MAX_WIDTH]);
  });
});

describe("globals.css stays bound to the scale", () => {
  const css = read(join(SRC, "app/globals.css"));

  it("has no hardcoded width media query", () => {
    const literals = css.match(/@media[^{]*\((?:min|max)-width:\s*\d[^)]*\)/g) ?? [];
    expect(
      literals,
      'width media queries must read theme("screens.…") — a pixel literal here is how the ' +
        "`.table-stack` collapse and TableShell's `md:` frame drift apart",
    ).toEqual([]);
  });

  it("bounds its raw block on screens.lg", () => {
    const bound = css.match(/@media not all and \(min-width: theme\("screens\.lg"\)\)/g) ?? [];
    expect(bound).toHaveLength(1);
    // …and it is the one we know about, still guarding what it was written to
    // guard. (There were two until the Sentry feedback widget was replaced by a
    // first-party dialog; the second bounded a `--bottom` offset on the SDK's
    // floating trigger, which no longer renders.)
    expect(css).toMatch(/screens\.lg"\)\) \{[\s\S]*?table\.table-stack thead/);
  });
});

describe("playwright audits the desktop render", () => {
  const CONFIGS = ["playwright.config.ts", "playwright.a11y.config.ts"];

  it("pins every browser project above the desktop threshold", () => {
    for (const name of CONFIGS) {
      const text = read(join(WEB_ROOT, name));
      const widths = [...text.matchAll(/viewport:\s*\{\s*width:\s*(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      const declared = [...text.matchAll(/width:\s*(\d+),\s*height:\s*\d+/g)].map((m) =>
        Number(m[1]),
      );
      const all = [...widths, ...declared];
      expect(all.length, `${name} declares no explicit viewport`).toBeGreaterThan(0);
      for (const width of all) {
        expect(width, `${name} pins a viewport below DESKTOP_MIN_WIDTH`).toBeGreaterThanOrEqual(
          DESKTOP_MIN_WIDTH,
        );
      }
    }
  });

  it("never spreads the Desktop Chrome preset without pinning a viewport", () => {
    for (const name of CONFIGS) {
      const text = read(join(WEB_ROOT, name));
      const presets = text.match(/\.\.\.devices\["Desktop Chrome"\]/g) ?? [];
      const pinned = text.match(/\.\.\.devices\["Desktop Chrome"\],\s*viewport:/g) ?? [];
      expect(
        pinned.length,
        `${name}: the preset is 1280x720, one pixel below DESKTOP_MIN_WIDTH — an unpinned ` +
          "project audits the mobile render and still passes",
      ).toBe(presets.length);
    }
  });
});

describe("responsive prefixes resolve to a declared screen", () => {
  it("defines a screen for every prefix the app uses", () => {
    const declared = new Set(Object.keys(SCREENS));
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      // The trailing character class is what keeps this off `logo.tsx`'s SIZES
      // record keys and `calendar-grid.ts`'s `ymd:` field — a bare /\bmd:/ hits
      // both. A prefix is only a variant when a utility follows it.
      for (const [, prefix] of read(file).matchAll(/\b(sm|md|lg|xl|2xl|roomy):[a-z[]/g)) {
        if (!declared.has(prefix)) offenders.push(`${relative(WEB_ROOT, file)} → ${prefix}:`);
      }
    }
    // `screens` is a replacement: an undeclared prefix compiles to NOTHING, so
    // the utility silently never applies at any width.
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("keeps `max-<screen>:` out of the app — this config generates no such variant", () => {
    // Tailwind builds the `max-*` variants from `theme.screens`, and switches
    // that generation OFF ENTIRELY as soon as one screen is a `raw` media
    // query. This scale has two (`desktop`, `desktop-wide` — they add
    // `pointer: fine`, which a width cannot express), so `max-sm:`, `max-lg:`
    // and even `max-[639px]:` all compile to nothing here. Verified against
    // tailwindcss 3.4 with and without a raw entry.
    //
    // Nothing warns: the class stays in the markup and the rule never exists,
    // so a phone-only style is simply absent and reads as a styling mistake
    // somewhere else. Express it unprefixed and RESET it at the breakpoint
    // instead — see the `sheet` placement in components/ui/dialog.tsx.
    const hasRawScreen = Object.values(SCREENS).some(
      (value) => typeof value === "object" && value !== null && "raw" in value,
    );
    expect(hasRawScreen, "a raw screen is what disables the max-* variants").toBe(true);

    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      for (const [, prefix] of read(file).matchAll(/\bmax-(sm|md|lg|xl|2xl|roomy):[a-z[]/g)) {
        offenders.push(`${relative(WEB_ROOT, file)} → max-${prefix}:`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("keeps arbitrary width variants out of the app, so the scale stays the one dial", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const text = read(file);
      if (/\b(?:min|max)-\[\d+px\]:/.test(text) || /\[@media\s*\((?:min|max)-width/.test(text)) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    // A `min-[900px]:` or `[@media(min-width:900px)]:` utility is a second,
    // invisible scale: it reads like a breakpoint and answers to nothing. When
    // a width genuinely isn't a device tier, give it a NAMED screen the way
    // `roomy` is named, so it lands in SCREENS with the rest.
    //
    // Two things this deliberately does NOT flag, because neither is Tailwind
    // layout: raw CSS media queries inside template strings for standalone HTML
    // (src/lib/email/html-shell.ts, src/app/r/email-uns/[token]/route.ts — mail
    // clients and a hand-written response page, no Tailwind involved), and
    // `[@media(pointer:coarse)]:` in chat-room.tsx, which asks about the input
    // device rather than the width.
    expect(offenders).toEqual([]);
  });
});
