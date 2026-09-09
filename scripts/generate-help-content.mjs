#!/usr/bin/env node
// Generate packages/shared/src/content/generated.ts — the in-app help
// content registry — from docs/help/{teacher,student}/*.md, so the app's
// help center and the contributor-facing docs tree can't drift apart into
// two separate copies of the same guidance.
//
// packages/shared has no build step (apps consume ./src/*.ts directly), and
// Metro has no loader for raw .md, so the parsed docs are baked into a
// checked-in .ts module rather than read at runtime.
//
//   node scripts/generate-help-content.mjs           # (re)write the file
//   node scripts/generate-help-content.mjs --check    # CI: fail if stale, write nothing
//
// Each audience folder's index.md is the source of doc order (its link
// list), not directory iteration order — that's the curated order the app's
// audience index page renders in. index.md itself is navigation, not a doc,
// and is skipped.
//
// A doc's Spanish translation, when it exists, lives as a sibling
// `<slug>.es-MX.md` next to `<slug>.md` — same structure, translated
// headings included. There's no `fr` variant yet; ContentDoc.localize()
// falls back to `en` for any locale without its own file.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP_DIR = path.join(repoRoot, "docs/help");
const OUT = path.join(repoRoot, "packages/shared/src/content/generated.ts");

const AUDIENCES = ["teacher", "student"];

/** Slugs whose doc is safe to show to a signed-out visitor on the public,
 *  unauthenticated marketing /help FAQ, and (on mobile) to a HelpHint tapped
 *  from a pre-auth screen — mobile's /help/[slug] falls back to the
 *  "teacher" audience for a signed-out visitor, so this is also the set a
 *  pre-auth HelpHint may safely link to. Mirrors the old registry's
 *  teacher-only publicFaq flags (payments/plans/auth), which targeted
 *  prospective teachers (the signup funnel), not students. */
const PUBLIC_FAQ = new Set([
  "teacher/getting-started",
  "teacher/packages-and-payments",
  "teacher/settings-and-subscription",
  "teacher/availability-and-booking",
]);

// Structural, not keyword-based, so it parses a translated file's headings
// (e.g. "## Propósito") without a language-specific alias list: the summary
// is always the first `##` section after the title, and "Related articles" —
// stripped below — is always the last `##` section in the doc.
function parseDoc(audience, slug, locale, raw) {
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  if (!titleMatch) throw new Error(`${audience}/${slug} (${locale}): missing an H1 title`);
  const title = titleMatch[1].trim();

  const afterTitle = raw.slice(titleMatch.index + titleMatch[0].length).trim();
  const sections = [...afterTitle.matchAll(/^##\s+.+$/gm)];
  if (sections.length < 2) {
    throw new Error(
      `${audience}/${slug} (${locale}): expected at least two "##" sections (a summary section and a trailing related-links section)`,
    );
  }

  const firstSectionEnd = sections[1].index;
  const summaryBody = afterTitle
    .slice(sections[0].index + sections[0][0].length, firstSectionEnd)
    .trim();
  const summary = summaryBody.split(/\n{2,}/)[0].trim();

  const lastSection = sections[sections.length - 1];
  let body = afterTitle.slice(0, lastSection.index).trim();
  // Screenshot placeholders and the trailing related-links section are
  // contributor-doc scaffolding, not renderable app copy: mobile's shared
  // markdown renderer only opens absolute, scheme-allow-listed URLs
  // (ClassContentMarkdown / safeExternalHref), so a bare relative
  // `(other-doc.md)` link would silently render as dead text there.
  body = body.replace(/^\[[^\]]+\]$/gm, "");
  body = body.trim() + "\n";

  return { title, summary, body };
}

function escapeTemplateLiteral(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function readDocFile(dir, slug, locale) {
  const suffix = locale === "en" ? "" : `.${locale}`;
  const file = path.join(dir, `${slug}${suffix}.md`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function collectDocs() {
  const docs = [];
  for (const audience of AUDIENCES) {
    const dir = path.join(HELP_DIR, audience);
    const indexSrc = readFileSync(path.join(dir, "index.md"), "utf8");
    const linkedSlugs = [...indexSrc.matchAll(/\]\(([a-z0-9-]+)\.md\)/g)].map((m) => m[1]);

    const allSlugs = [
      ...new Set(
        readdirSync(dir)
          .filter((f) => f.endsWith(".md") && f !== "index.md" && !f.endsWith(".es-MX.md"))
          .map((f) => f.replace(/\.md$/, "")),
      ),
    ];

    // index.md's link order first, then any file it doesn't happen to link
    // (a safety net so a new doc can't silently go missing from the app).
    const orderedSlugs = [
      ...linkedSlugs.filter((s) => allSlugs.includes(s)),
      ...allSlugs.filter((s) => !linkedSlugs.includes(s)),
    ];

    for (const slug of orderedSlugs) {
      const enRaw = readDocFile(dir, slug, "en");
      if (enRaw == null) throw new Error(`${audience}/${slug}: missing ${slug}.md`);
      const en = parseDoc(audience, slug, "en", enRaw);

      const esRaw = readDocFile(dir, slug, "es-MX");
      const es = esRaw != null ? parseDoc(audience, slug, "es-MX", esRaw) : null;

      docs.push({
        audience,
        slug,
        title: { en: en.title, ...(es ? { "es-MX": es.title } : {}) },
        summary: { en: en.summary, ...(es ? { "es-MX": es.summary } : {}) },
        body: { en: en.body, ...(es ? { "es-MX": es.body } : {}) },
        publicFaq: PUBLIC_FAQ.has(`${audience}/${slug}`),
      });
    }
  }
  return docs;
}

function renderLocalizedText(text) {
  const entries = Object.entries(text).map(([locale, value]) =>
    locale === "en"
      ? `en: \`${escapeTemplateLiteral(value)}\``
      : `${JSON.stringify(locale)}: \`${escapeTemplateLiteral(value)}\``,
  );
  return `{ ${entries.join(", ")} }`;
}

function render(docs) {
  const entries = docs
    .map(
      (doc) => `  {
    slug: ${JSON.stringify(doc.slug)},
    audience: ${JSON.stringify(doc.audience)},
    title: ${renderLocalizedText(doc.title)},
    summary: ${renderLocalizedText(doc.summary)},
    body: ${renderLocalizedText(doc.body)},${doc.publicFaq ? "\n    publicFaq: true," : ""}
  },`,
    )
    .join("\n");

  return `// AUTO-GENERATED by scripts/generate-help-content.mjs from docs/help/**/*.md.
// Do not hand-edit — change the source .md file and regenerate:
//   node scripts/generate-help-content.mjs

import type { ContentDoc } from "./types";

export const GENERATED_HELP_DOCS: readonly ContentDoc[] = [
${entries}
];
`;
}

function main() {
  const docs = collectDocs();
  const output = render(docs);
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    let existing = "";
    try {
      existing = readFileSync(OUT, "utf8");
    } catch {
      existing = "";
    }
    if (existing !== output) {
      console.error(
        "packages/shared/src/content/generated.ts is stale — run `node scripts/generate-help-content.mjs`.",
      );
      process.exit(1);
    }
    console.log("packages/shared/src/content/generated.ts is up to date.");
    return;
  }

  writeFileSync(OUT, output);
  const withEs = docs.filter((d) => d.title["es-MX"]).length;
  console.log(
    `Wrote ${docs.length} help docs (${withEs} with es-MX) to ${path.relative(repoRoot, OUT)}`,
  );
}

main();
