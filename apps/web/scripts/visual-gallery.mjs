// Turns a visual-baseline capture into something a person can actually look
// at, and into something a repository can actually hold.
//
// `pnpm test:visual` writes one full-page PNG per route per viewport per
// theme. The full sweep is ~1,200 images and roughly 600 MB — twenty times the
// size of this repository's entire history — so the raw output is gitignored
// build product. This script produces the two things that outlive it:
//
//   --index     A contact sheet (docs/design/gallery/<label>/index.html) that
//               puts every capture of one route side by side across the six
//               viewports and both themes. This is how you actually SEE that a
//               section's container width disagrees with its neighbour's, or
//               that a badge went light-on-light in dark mode — a defect that
//               is invisible one screenshot at a time.
//
//   --evidence  The committed set: the portfolio surfaces only, downscaled and
//               JPEG-encoded, plus a checksum manifest naming what was
//               captured, when, and against which origin. Roughly 5 MB rather
//               than 600, and it is what the before-and-after actually rests
//               on. The manifest matters as much as the images: it makes the
//               claim checkable by someone who was not there.
//
// macOS `sips` does the encoding, so there is no image dependency to install.
//
//   node scripts/visual-gallery.mjs --index --label before
//   node scripts/visual-gallery.mjs --evidence --label before
import { createHash } from "node:crypto";
import { brandPalette as BRAND } from "../../../packages/shared/src/tokens.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import prettier from "prettier";

/**
 * Write a generated file the way the repository's format gate expects it.
 *
 * `JSON.stringify(x, null, 2)` always expands arrays; Prettier collapses short
 * ones. Without this the manifest is regenerated red on every run and someone
 * hand-fixes a generated file, which is the failure this indirection exists to
 * prevent.
 */
async function writeFormatted(path, contents, parser) {
  const config = (await prettier.resolveConfig(path)) ?? {};
  writeFileSync(path, await prettier.format(contents, { ...config, parser, filepath: path }));
}

const REPO = resolve(new URL(".", import.meta.url).pathname, "../../..");
const GALLERY_ROOT = join(REPO, "docs/design/gallery");
const EVIDENCE_ROOT = join(REPO, "docs/design/evidence");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const LABEL = arg("--label", "before");
const SOURCE = join(GALLERY_ROOT, LABEL);

/** Longest edge of a committed evidence image. Enough to read the layout and
 * the type hierarchy; not enough to store a 6,600px full-page render. */
const EVIDENCE_MAX_EDGE = 1400;
const EVIDENCE_QUALITY = "72";

/** The viewport/theme combinations worth committing: one phone width and one
 * desktop width, in both themes. The other four viewports exist to catch
 * breakpoint faults, which is a job for the contact sheet, not the archive. */
const EVIDENCE_PROJECTS = ["390-light", "390-dark", "1440-light", "1440-dark"];

function readCaptures(sourceDir) {
  if (!existsSync(sourceDir)) {
    throw new Error(`No capture at ${sourceDir}. Run \`pnpm test:visual\` first, or pass --label.`);
  }
  const captures = [];
  for (const project of readdirSync(sourceDir)) {
    const dir = join(sourceDir, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".png")) continue;
      const png = join(dir, file);
      const sidecar = png.replace(/\.png$/, ".json");
      const meta = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : {};
      captures.push({
        project,
        name: basename(file, ".png"),
        png,
        bytes: statSync(png).size,
        ...meta,
      });
    }
  }
  return captures;
}

/** Group captures by route name, so one row of the contact sheet is one
 * screen across every viewport and theme. */
function byRoute(captures) {
  const rows = new Map();
  for (const capture of captures) {
    if (!rows.has(capture.name)) rows.set(capture.name, []);
    rows.get(capture.name).push(capture);
  }
  return [...rows.entries()]
    .map(([name, shots]) => ({
      name,
      path: shots[0]?.path ?? "",
      tier: shots[0]?.tier ?? "",
      portfolio: shots.some((s) => s.portfolio),
      shots: shots.sort((a, b) => a.project.localeCompare(b.project, undefined, { numeric: true })),
    }))
    .sort((a, b) => {
      if (a.portfolio !== b.portfolio) return a.portfolio ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

async function buildIndex() {
  const captures = readCaptures(SOURCE);
  const rows = byRoute(captures);
  const totalMb = (captures.reduce((n, c) => n + c.bytes, 0) / 1e6).toFixed(0);
  const origin = captures.find((c) => c.baseURL)?.baseURL ?? "unknown";
  const capturedAt = captures.find((c) => c.capturedAt)?.capturedAt ?? "";

  const section = (row) => `
    <section id="${row.name}">
      <h2>${row.name} <span class="meta">${row.path}</span>${row.portfolio ? '<span class="tag">portfolio</span>' : ""}</h2>
      <div class="strip">
        ${row.shots
          .map(
            (s) => `<figure>
              <a class="shot" href="${s.project}/${s.name}.png" target="_blank" rel="noreferrer">
                <img loading="lazy" src="${s.project}/${s.name}.png" alt="${row.name} at ${s.project}">
              </a>
              <figcaption>${s.project}</figcaption>
            </figure>`,
          )
          .join("")}
      </div>
    </section>`;

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpiralClass visual baseline — ${LABEL}</title>
<style>
  /* Taken from the palette, not typed here. The contact sheet IS the design
     evidence, so styling it in the brand the evidence supersedes was its own
     small joke — these were the pre-D-140 terracotta values. */
  :root { color-scheme: light dark; --ink:${BRAND.ink}; --paper:${BRAND.paper}; --muted:${BRAND.text}; --line:${BRAND.gold}; }
  @media (prefers-color-scheme: dark) { :root { --ink:#f3ece3; --paper:#191210; --muted:#a89684; --line:#3b2d26; } }
  body { margin:0; padding:2rem clamp(1rem,4vw,3rem); background:var(--paper); color:var(--ink);
         font:15px/1.5 ui-sans-serif,system-ui,sans-serif; }
  header { border-bottom:1px solid var(--line); padding-bottom:1.5rem; margin-bottom:2rem; }
  h1 { margin:0 0 .5rem; font-size:1.6rem; }
  .meta { color:var(--muted); font-weight:400; font-size:.85em; margin-left:.5rem; }
  .tag { background:var(--line); color:var(--ink); font-size:.65em; padding:.15em .5em;
         border-radius:999px; margin-left:.6rem; vertical-align:middle; letter-spacing:.04em;
         text-transform:uppercase; }
  nav { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:1rem; }
  nav a { font-size:.8rem; color:var(--muted); text-decoration:none; border:1px solid var(--line);
          padding:.2rem .55rem; border-radius:999px; }
  nav a:hover { color:var(--ink); }
  section { margin-bottom:3rem; }
  h2 { font-size:1.05rem; margin:0 0 .75rem; }
  .strip { display:flex; gap:1rem; overflow-x:auto; padding-bottom:.75rem; }
  figure { margin:0; flex:0 0 auto; width:260px; }
  /* Full-page renders run to 6,600px. Shown whole they are unreadable and the
     page is 40 screens long, so each cell crops to the top of the page — the
     fold, which is what you compare across viewports — and links to the full
     image for when you need the rest. */
  a.shot { display:block; height:340px; overflow:hidden; border:1px solid var(--line);
           border-radius:6px; background:#fff; }
  img { width:100%; height:100%; object-fit:cover; object-position:top; display:block; }
  figcaption { font-size:.75rem; color:var(--muted); margin-top:.35rem; text-align:center; }
</style>
<header>
  <h1>Visual baseline — ${LABEL}</h1>
  <p class="meta">${rows.length} routes · ${captures.length} captures · ${totalMb} MB · ${origin}${capturedAt ? ` · ${capturedAt.slice(0, 10)}` : ""}</p>
  <nav>${rows.map((r) => `<a href="#${r.name}">${r.name}</a>`).join("")}</nav>
</header>
${rows.map(section).join("\n")}
`;

  const out = join(SOURCE, "index.html");
  await writeFormatted(out, html, "html");
  console.log(`Contact sheet: ${out}`);
  console.log(`  ${rows.length} routes, ${captures.length} captures, ${totalMb} MB`);
}

async function buildEvidence() {
  const captures = readCaptures(SOURCE).filter(
    (c) => c.portfolio && EVIDENCE_PROJECTS.includes(c.project),
  );
  if (captures.length === 0) {
    throw new Error(
      `No portfolio-tier captures at ${EVIDENCE_PROJECTS.join(", ")} in ${SOURCE}. ` +
        `Check the manifest's \`portfolio\` flags and the capture's viewport projects.`,
    );
  }

  const outDir = join(EVIDENCE_ROOT, LABEL);
  mkdirSync(outDir, { recursive: true });

  const entries = [];
  for (const capture of captures) {
    const target = join(outDir, `${capture.name}__${capture.project}.jpg`);
    execFileSync("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      EVIDENCE_QUALITY,
      "-Z",
      String(EVIDENCE_MAX_EDGE),
      capture.png,
      "--out",
      target,
    ]);
    const bytes = readFileSync(target);
    entries.push({
      name: capture.name,
      path: capture.path,
      project: capture.project,
      file: `${basename(target)}`,
      bytes: bytes.length,
      // The checksum is of the committed JPEG, so the manifest verifies what
      // is actually in the repository rather than an original nobody has.
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const totalMb = (entries.reduce((n, e) => n + e.bytes, 0) / 1e6).toFixed(1);
  const source = captures[0];
  const manifest = {
    label: LABEL,
    capturedAt: source.capturedAt ?? null,
    origin: source.baseURL ?? null,
    // Provenance, so the before/after is checkable rather than asserted.
    commit: gitRev(),
    encoding: {
      format: "jpeg",
      quality: Number(EVIDENCE_QUALITY),
      maxEdge: EVIDENCE_MAX_EDGE,
      note: "Full-page renders, downscaled. The raw PNGs are gitignored build output.",
    },
    projects: EVIDENCE_PROJECTS,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    images: entries.sort((a, b) => a.file.localeCompare(b.file)),
  };
  await writeFormatted(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "json");

  console.log(`Evidence set: ${outDir}`);
  console.log(`  ${entries.length} images, ${totalMb} MB, manifest written.`);
}

function gitRev() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
  } catch {
    return null;
  }
}

const wantsIndex = process.argv.includes("--index");
const wantsEvidence = process.argv.includes("--evidence");
const runBoth = !wantsIndex && !wantsEvidence;

if (wantsIndex || runBoth) await buildIndex();
if (wantsEvidence || runBoth) await buildEvidence();
