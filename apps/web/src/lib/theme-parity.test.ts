import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { palette, paletteDark, type PaletteToken } from "@spiralclass/shared";

// The web theme is authored twice: canonical hex in packages/shared/src/tokens.ts
// (which mobile consumes directly) and a hand-written HSL mirror in
// src/app/globals.css (which the browser consumes). Nothing used to check the two
// agreed — which is exactly how `accent` came to mean pale-cream on mobile but
// vivid-gold on web, and how the dark surface ladder inverted. This test closes
// that gap: it parses the CSS variables, converts HSL→hex, and asserts each maps
// back to the shared palette. A rounding wobble is a couple of units; a real role
// drift (cream vs gold) is >100 — the tolerance below catches the latter without
// tripping on the former.

/** globals.css `--token` → shared palette key. Only tokens that are meant to be
 * the SAME colour on both platforms are listed. Web-only tokens (chart-*, the
 * success/warning/info *-foreground on-state text, ring=primary, input=border,
 * radius, shadow-color) are intentionally omitted. */
const TOKEN_MAP: Record<string, PaletteToken> = {
  background: "background",
  foreground: "text",
  card: "surface",
  popover: "surface",
  primary: "primary",
  "primary-foreground": "primaryText",
  secondary: "secondary",
  "secondary-foreground": "secondaryText",
  muted: "muted",
  "muted-foreground": "textMuted",
  accent: "accent",
  "accent-foreground": "accentText",
  destructive: "danger",
  "destructive-foreground": "dangerText",
  success: "success",
  warning: "warning",
  info: "info",
  clay: "clay",
  sage: "sage",
  border: "border",
  // Added after the dark raised-surface moved and `--foreground-subtle` did
  // not follow it: the CSS value and the palette value are meant to be one
  // colour, and nothing was checking that they still were.
  "foreground-subtle": "textSubtle",
};

// Per-channel tolerance (0–255). Rounding H to whole degrees and S/L to whole
// percents costs a few units round-tripping; 6 absorbs that while a swapped role
// (off by dozens) still fails loudly.
const TOLERANCE = 6;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Pull `--token: H S% L%;` declarations out of a single CSS rule body. */
function parseBlock(css: string, selector: string): Record<string, [number, number, number]> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector ${selector} not found in globals.css`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const out: Record<string, [number, number, number]> = {};
  const re = /--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out[m[1]] = hslToRgb(Number(m[2]), Number(m[3]) / 100, Number(m[4]) / 100);
  }
  return out;
}

const globalsCss = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

describe("web ⇄ shared theme parity", () => {
  const cases: Array<["light" | "dark", string, Record<PaletteToken, string>]> = [
    ["light", ":root", palette],
    ["dark", ".dark", paletteDark],
  ];

  for (const [name, selector, source] of cases) {
    describe(`${name} theme (${selector})`, () => {
      const vars = parseBlock(globalsCss, selector);

      for (const [cssVar, token] of Object.entries(TOKEN_MAP)) {
        it(`--${cssVar} matches shared ${token}`, () => {
          const got = vars[cssVar];
          expect(got, `--${cssVar} missing from ${selector}`).toBeDefined();
          const want = hexToRgb(source[token]);
          for (let i = 0; i < 3; i++) {
            expect(
              Math.abs(got[i] - want[i]),
              `--${cssVar} channel ${i}: css=${got} shared=${source[token]}=${want}`,
            ).toBeLessThanOrEqual(TOLERANCE);
          }
        });
      }
    });
  }
});
