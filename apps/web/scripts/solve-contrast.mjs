#!/usr/bin/env node
/**
 * Solve a palette colour for the contrast its role requires (D-140).
 *
 * WHY THIS IS A SCRIPT NOW. The palette's comment has always said every value
 * is "the smallest OKLCH lightness step that clears the contrast its role
 * requires, solved against the hardest surface in its own theme" — but the
 * solve itself was done by hand and never committed, so `palette-contrast`
 * could tell you to re-run it and leave you no way to. That gap is exactly how
 * the dark `textSubtle` and `borderStrong` drifted below AA the moment the
 * raised surface moved: nobody could cheaply redo the thing the comment named.
 *
 * WHAT IT DOES. Holds hue and chroma fixed and binary-searches OKLCH lightness
 * for the smallest step that clears the target ratio against the given ground.
 * Hue and chroma are held because they carry the brand; lightness is the axis
 * that carries contrast, so moving only lightness changes legibility without
 * changing the colour's identity.
 *
 *   node scripts/solve-contrast.mjs '#8e929c' '#292e38' 4.5
 *   node scripts/solve-contrast.mjs '#71757d' '#292e38' 3 --darker
 *
 * `--darker` searches downward instead, for a colour on a light ground.
 */

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((v) => v / 255);
}

function rgbToHex([r, g, b]) {
  const to = (v) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** WCAG 2.1 relative luminance — the definition the success criteria use. */
function luminance(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToOklch([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToRgb([L, C, h]) {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(linearToSrgb);
}

const [, , colorArg, groundArg, ratioArg, ...flags] = process.argv;
if (!colorArg || !groundArg || !ratioArg) {
  console.error("usage: solve-contrast.mjs <#color> <#ground> <ratio> [--darker]");
  process.exit(2);
}

const ground = hexToRgb(groundArg);
const target = Number(ratioArg);
const darker = flags.includes("--darker");
const [, C, h] = rgbToOklch(hexToRgb(colorArg));

// Binary search on lightness. `lo` is the end that fails and `hi` the end that
// passes, so the answer converges on the smallest passing step — "smallest"
// being the whole point: overshooting lightness is how a subtle label turns
// into a second body-text colour.
let lo = darker ? rgbToOklch(hexToRgb(colorArg))[0] : rgbToOklch(hexToRgb(colorArg))[0];
let hi = darker ? 0 : 1;
if (contrast(oklchToRgb([hi, C, h]), ground) < target) {
  console.error(
    `No lightness clears ${target}:1 against ${groundArg} at this chroma. ` +
      `Reduce chroma, or reconsider the ground.`,
  );
  process.exit(1);
}
for (let i = 0; i < 60; i++) {
  const mid = (lo + hi) / 2;
  if (contrast(oklchToRgb([mid, C, h]), ground) >= target) hi = mid;
  else lo = mid;
}

const solved = oklchToRgb([hi, C, h]);
const hex = rgbToHex(solved);
// Report the ratio of the ROUNDED hex, not the float — the rounded value is
// what ships, and it can land a hair under the target.
const actual = contrast(hexToRgb(hex), ground);
console.log(
  `${colorArg} -> ${hex}  (${actual.toFixed(2)}:1 against ${groundArg}, target ${target}:1)`,
);
if (actual < target) {
  // Nudge one step further so rounding cannot leave it failing.
  for (let i = 1; i <= 12; i++) {
    const step = oklchToRgb([darker ? hi - i * 0.002 : hi + i * 0.002, C, h]);
    const stepHex = rgbToHex(step);
    if (contrast(hexToRgb(stepHex), ground) >= target) {
      console.log(
        `rounding nudge -> ${stepHex} (${contrast(hexToRgb(stepHex), ground).toFixed(2)}:1)`,
      );
      break;
    }
  }
}
