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
//   2. globals.css, whose raw media query is the other half of a switch whose
//      first half is an `lg:` utility. A number there that drifts from the
//      scale is how `.table-stack` and TableShell's frame end up disagreeing
//      about what "below lg" means, leaving a band of widths that draws a
//      desktop table frame around already-stacked cards.
//
//      Under Tailwind 3 this file could REFER to the scale — `theme("screens.
//      lg")` — and the guard was simply "no literals here". Tailwind 4 took
//      that away: a legacy `@config` file supplies utilities but not the
//      `--breakpoint-*` custom properties `theme()` resolves against, so
//      `theme("screens.lg")` silently answered from v4's OWN default scale.
//      It emitted 64rem, which happens to equal this app's lg, and would have
//      gone on emitting 64rem however far lg moved. So globals.css now holds
//      literals on purpose, and the guards below changed from "there are no
//      literals" to "every literal matches the scale" — a mirror with a parity
//      check, which is what the colour tokens in that same file already are.
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

  it("feeds theme.screens the width-based half of the scale, from breakpoints.ts", () => {
    // Tailwind 4 cannot hold a `raw` media query in theme.screens: its
    // container compatibility shim writes `max-width: <every screen's value>`,
    // so a raw entry came out as `max-width: (min-width: 1024px) and (pointer:
    // fine)`. The two pointer-gated screens live in globals.css as
    // `@custom-variant` instead — the test below is what keeps them honest.
    const widthOnly = Object.fromEntries(
      Object.entries(SCREENS).filter(([, value]) => typeof value === "string"),
    );
    expect(theme.screens).toEqual(widthOnly);
  });

  it("keeps every pointer-gated screen in globals.css, spelled exactly as SCREENS spells it", () => {
    // The other half of the scale. These are still DECLARED in breakpoints.ts —
    // this asserts globals.css mirrors each one character for character, so
    // editing either side alone is a failing test rather than a variant that
    // silently stops matching the device it was written for.
    const css = read(join(SRC, "app/globals.css"));
    const missing: string[] = [];
    for (const [name, value] of Object.entries(SCREENS)) {
      if (typeof value === "string") continue;
      const expected = `@custom-variant ${name} (@media ${value.raw});`;
      if (!css.includes(expected)) missing.push(expected);
    }
    expect(
      missing,
      `globals.css must declare each raw screen verbatim:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("replaces the default scale instead of extending it", () => {
    // `extend.screens` merges, so sm would resolve to 640px again and every
    // tablet would silently go back to the desktop layout.
    const extend = (theme.extend ?? {}) as Record<string, unknown>;
    expect(extend.screens).toBeUndefined();
  });

  it("pins the container ceiling in globals.css to CONTAINER_MAX_WIDTH", () => {
    // Tailwind 4 removed the container plugin's options, so `.container` is
    // written out in globals.css. Its cap is a literal there — v4 exposes no
    // custom property for a legacy config's theme values — so this is the
    // parity check that keeps the literal equal to the constant.
    const css = read(join(SRC, "app/globals.css"));
    const utility = css.match(/@utility container \{([\s\S]*?)\n\}/);
    expect(utility, "globals.css must define the container utility").not.toBeNull();
    expect(utility?.[1]).toContain(`max-width: ${CONTAINER_MAX_WIDTH};`);
  });

  it("no longer asks the Tailwind config for a container, which v4 would misread", () => {
    // Leaving a `container` key in place would not error. v4 ignores its
    // options and derives `.container` from theme.screens regardless, so the
    // key would read as the source of a ceiling it no longer sets.
    expect(theme.container).toBeUndefined();
  });
});

describe("globals.css stays bound to the scale", () => {
  const css = read(join(SRC, "app/globals.css"));

  it("uses no width in a media query that is not a value from the scale", () => {
    // The v3 rule was "no literals at all", enforceable because theme() worked.
    // The rule now is that every width written here is one the scale declares —
    // which catches the thing that actually goes wrong (a number drifting away
    // from `lg`) without banning the literals v4 forces.
    //
    // `@custom-variant` lines are excluded: those are the mirrored raw screens,
    // and the test above already compares them to SCREENS character for
    // character.
    const declared = new Set<string>(
      Object.values(SCREENS).map((value) => (typeof value === "string" ? value : value.raw)),
    );
    const offenders: string[] = [];
    for (const line of css.split("\n")) {
      if (line.trimStart().startsWith("@custom-variant")) continue;
      for (const [, width] of line.matchAll(/@media[^{]*\((?:min|max)-width:\s*(\d+px)\)/g)) {
        if (!declared.has(width)) offenders.push(line.trim());
      }
    }
    expect(
      offenders,
      "a width media query here must use a width SCREENS declares — a number of its own is how " +
        "the `.table-stack` collapse and TableShell's `lg:` frame drift apart:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("bounds its raw block on SCREENS.lg", () => {
    const bound = css.match(new RegExp(`@media not all and \\(min-width: ${SCREENS.lg}\\)`, "g"));
    expect(bound, `the table-stack collapse must be bounded at lg (${SCREENS.lg})`).toHaveLength(1);
    // …and it is the one we know about, still guarding what it was written to
    // guard. (There were two until the Sentry feedback widget was replaced by a
    // first-party dialog; the second bounded a `--bottom` offset on the SDK's
    // floating trigger, which no longer renders.)
    expect(css).toMatch(
      new RegExp(`min-width: ${SCREENS.lg}\\) \\{[\\s\\S]*?table\\.table-stack thead`),
    );
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
