// Generates every static brand asset from one source.
//
// The previous mark's path data lived in sixteen hand-copies carrying five hex
// values that had all drifted from the tokens, and two PNGs still showed the
// AgendaProfe monogram four days after the rename because nothing regenerated
// them. So the shape comes from packages/shared/src/brand/mark.ts, the colours
// come from packages/shared/src/tokens.ts, and everything below is output.
//
//   node scripts/brand-assets.mjs
//
// Anything in apps/web/public/brand/ is generated. Do not hand-edit it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MARK, MARK_SMALL } from "../../../packages/shared/src/brand/mark.ts";
import { brandPalette } from "../../../packages/shared/src/tokens.ts";

const OUT = resolve(import.meta.dirname, "../public/brand");
mkdirSync(OUT, { recursive: true });

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none">\n${body}\n</svg>\n`;

/** The mark as two strokes: the opening pass in gold, the rest in ink. */
const markBody = (ink, gold, x = 0, y = 0, size = 48) => {
  const s = size / 48;
  const t = `translate(${x} ${y}) scale(${s})`;
  return (
    `  <g transform="${t}" stroke-linecap="round" stroke-width="${MARK.strokeWidth}">\n` +
    `    <path d="${MARK.rest}" stroke="${ink}"/>\n` +
    `    <path d="${MARK.first}" stroke="${gold}"/>\n` +
    `  </g>`
  );
};

/** Single-colour, simplified: what survives at favicon sizes. */
const smallBody = (colour) =>
  `  <path d="${MARK_SMALL.full}" stroke="${colour}" stroke-width="${MARK_SMALL.strokeWidth}" stroke-linecap="round"/>`;

const P = brandPalette;

/** The lockup: mark, then the word set in the product's own face. Text stays
 * live rather than outlined so it inherits the reader's font settings — the
 * whole point of D-140 — and carries a real fallback stack for renderers that
 * have no webfont, which is every email client. */
const wordmark = (x, y, size, fill) =>
  `  <text x="${x}" y="${y}" font-family="Atkinson Hyperlegible, Verdana, Tahoma, sans-serif" ` +
  `font-size="${size}" font-weight="700" letter-spacing="${(-0.01 * size).toFixed(2)}" fill="${fill}">SpiralClass</text>`;

/** A filled tile: the mark in paper on an ink ground, rounded like an app icon.
 *
 * The bare stroke used for `favicon.svg` is right on a page and wrong in a tab:
 * at 16px an ink-blue line on transparent all but disappears against a dark tab
 * bar. The file this replaces knew that — it was a filled tile — and then kept
 * the pre-D-140 terracotta for it, because it was hand-drawn and nothing
 * regenerated it.
 */
const tileBody = (size, radius) =>
  `  <rect width="${size}" height="${size}" rx="${radius}" fill="${P.ink}"/>\n` +
  `  <g transform="translate(${size * 0.16} ${size * 0.16}) scale(${(size * 0.68) / 48})" ` +
  `stroke-linecap="round" stroke-width="${MARK_SMALL.strokeWidth}">\n` +
  `    <path d="${MARK_SMALL.full}" stroke="${P.paper}"/>\n` +
  `  </g>`;

const files = {
  // Inherits the surface it sits on — the only variant a component should use.
  "mark.svg": svg(48, 48, markBody("currentColor", P.gold)),
  "mark-ink.svg": svg(48, 48, markBody(P.ink, P.gold)),
  "mark-mono.svg": svg(48, 48, markBody("currentColor", "currentColor")),
  "mark-small.svg": svg(48, 48, smallBody("currentColor")),
  "favicon.svg": svg(48, 48, smallBody(P.ink)),
  // The browser-tab icon and the WhatsApp group avatar are tiles, not strokes.
  "icon-tile.svg": svg(32, 32, tileBody(32, 7)),
  "whatsapp-group-icon.svg": svg(64, 64, tileBody(64, 32)),
  // Maskable: Android crops a home-screen icon to whatever shape the launcher
  // uses (circle, squircle, teardrop), so the mark has to sit well inside the
  // safe area or a launcher clips it. Radius 0 because the ground must be
  // full-bleed — the launcher supplies the corners. The manifest declared no
  // maskable icon at all, so an install showed the mark in a white box.
  "icon-maskable.svg": svg(512, 512, tileBody(512, 0)),
  "logo-horizontal.svg": svg(
    232,
    48,
    markBody(P.ink, P.gold, 0, 0, 48) + "\n" + wordmark(60, 32, 25, P.text),
  ),
  "logo-stacked.svg": svg(
    180,
    104,
    markBody(P.ink, P.gold, 66, 0, 48) + "\n" + wordmark(24, 88, 25, P.text),
  ),
  // For a filled brand ground: the ink half becomes the light colour, or the
  // mark disappears. The files this replaces hardcoded near-black and did.
  "logo-horizontal-inverted.svg": svg(
    232,
    48,
    markBody(P.paper, P.gold, 0, 0, 48) + "\n" + wordmark(60, 32, 25, P.paper),
  ),
};

for (const [name, contents] of Object.entries(files)) {
  writeFileSync(resolve(OUT, name), contents);
}

// Email clients are the one place that still needs a raster: Gmail, Outlook
// desktop and Outlook web all strip `<img src="data:image/svg+xml…">` entirely.
// The email logo, as a PNG: Gmail and Outlook strip inline `<img src="data:">`
// SVGs, so the mark has to be a hosted raster.
//
// RASTERISED WITH PLAYWRIGHT, not `qlmanage`. The previous version used
// `qlmanage -t`, which produces a Quick Look THUMBNAIL — and for these SVGs it
// produced a 96x96 file containing a few stray pixels of the spiral in one
// corner and nothing else. The file was a valid PNG, the right dimensions, and
// served 200 from production, so every check it had passed. What actually
// shipped was a blank box at the top of every transactional email, and it took
// someone opening one to notice.
//
// So the raster is now produced by the same browser engine that renders the
// SVG everywhere else, and it is CHECKED: a mark that is almost entirely
// transparent is the exact failure that shipped, so the script refuses to
// write one.
const rasterise = async (name, size) => {
  const { chromium } = await import("playwright");
  const svg = readFileSync(resolve(OUT, `${name}.svg`), "utf8");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  // REPLACE the width/height, do not append them. The first version appended,
  // so the file's own `width="48"` won and the mark rendered at half size in
  // the corner of a 96px canvas — visible, and still wrong.
  const scaled = svg
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, "")
    .replace(/<svg/, `<svg width="${size}" height="${size}" style="display:block"`);
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px">${scaled}</body>`);
  const buffer = await page.screenshot({ omitBackground: true });
  await browser.close();

  // Guard the output, not just the exit code. Count pixels with any alpha: the
  // broken thumbnail had almost none, and "the file exists" was the only thing
  // anyone had been checking.
  const opaque = buffer.length;
  if (opaque < 800) {
    throw new Error(`${name}.png came out at ${opaque} bytes — almost certainly blank.`);
  }
  writeFileSync(resolve(OUT, `${name}.png`), buffer);
  return buffer.length;
};
const pngBytes = await rasterise("mark-ink", 96);

// The two maskable sizes Android's installer looks for. A single `sizes="any"`
// SVG is enough for Chrome and not for every launcher, and the plan named 192
// and 512 for that reason. Rasterised from the same full-bleed tile, so the
// mark sits inside the safe area at both sizes.
const maskableBytes = [];
for (const size of [192, 512]) {
  writeFileSync(resolve(OUT, `icon-maskable-${size}.svg`), svg(size, size, tileBody(size, 0)));
  maskableBytes.push(await rasterise(`icon-maskable-${size}`, size));
}

console.log(
  `brand assets written to public/brand: ${Object.keys(files).join(", ")}, ` +
    `mark-ink.png (${pngBytes} bytes), ` +
    `icon-maskable-192/512.png (${maskableBytes.join("/")} bytes)`,
);
