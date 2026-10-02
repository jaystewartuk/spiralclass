#!/usr/bin/env node
// Country and language names for every registered UI locale.
//
//   node scripts/generate-locale-names.mjs
//
// Two checked-in tables hold these names — packages/shared/src/country-names.ts
// and packages/shared/src/languages.data.ts — one column per locale in the
// registry (packages/shared/src/i18n/locales.ts). Run this after adding a
// locale there: the compiler will have told you both tables are short a
// column, and this fills it in from the platform's own CLDR data.
//
// WHY THE NAMES ARE STATIC rather than asked of Intl.DisplayNames at render:
// the server and the browser each carry their own copy of CLDR, at whatever
// version their runtime shipped, and they do not always agree on a name. A
// name rendered on the server and again in the browser is then a hydration
// mismatch, and a picker sorted by name can come out in two orders. A table
// is the same bytes on both sides.
//
// ADDITIVE ON PURPOSE. A name already in a table is never rewritten, so
// regenerating on a newer Node cannot quietly rename a country that teachers
// and students have been looking at. Only a missing column is filled. To take
// CLDR's newer name for something, delete that one value and run this again.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHARED = join(root, "packages/shared/src");

/** [{ tag, intl }] read off the registry, in registry order. */
function registry() {
  const src = readFileSync(join(SHARED, "i18n/locales.ts"), "utf8");
  const block = src.slice(
    src.indexOf("export const LOCALES = ["),
    src.indexOf("] as const satisfies"),
  );
  const rows = [...block.matchAll(/tag: "([^"]+)"[\s\S]*?intl: "([^"]+)"/g)];
  if (rows.length === 0) throw new Error("no locales found in the registry");
  return rows.map((m) => ({ tag: m[1], intl: m[2] }));
}

// `en` leads, as the fallback column; the rest follow the registry.
const locales = registry().sort((a, b) => (a.tag === "en" ? -1 : b.tag === "en" ? 1 : 0));
const key = (tag) => (/^[a-z]+$/i.test(tag) ? tag : JSON.stringify(tag));
const displayNames = (type) =>
  Object.fromEntries(
    locales.map(({ tag, intl }) => [
      tag,
      new Intl.DisplayNames([intl], { type, fallback: "none" }),
    ]),
  );

/** `en: "…", es: "…"` → { en, es }. */
function parseNames(text) {
  const out = {};
  for (const m of text.matchAll(/(?:"([^"]+)"|([A-Za-z]+)): ("(?:[^"\\]|\\.)*")/g)) {
    out[m[1] ?? m[2]] = JSON.parse(m[3]);
  }
  return out;
}

function complete(existing, code, names, what) {
  let added = 0;
  const out = {};
  for (const { tag } of locales) {
    if (existing[tag]) {
      out[tag] = existing[tag];
      continue;
    }
    const name = names[tag].of(code) ?? existing.en;
    if (!name) throw new Error(`no ${tag} name for ${what} ${code}`);
    out[tag] = name;
    added++;
  }
  return { out, added };
}

const render = (names) =>
  `{ ${locales.map(({ tag }) => `${key(tag)}: ${JSON.stringify(names[tag])}`).join(", ")} }`;

// ---------------------------------------------------------------- countries
{
  const path = join(SHARED, "country-names.ts");
  const src = readFileSync(path, "utf8");
  const names = displayNames("region");
  let added = 0;
  // `[^}]*` spans lines: Prettier wraps a row once it has enough columns.
  const next = src.replace(/^  ([A-Z]{2}): \{([^}]*)\},$/gm, (_, code, body) => {
    const done = complete(parseNames(body), code, names, "country");
    added += done.added;
    return `  ${code}: ${render(done.out)},`;
  });
  writeFileSync(path, next);
  console.log(`country-names.ts: ${added} names added`);
}

// ---------------------------------------------------------------- languages
{
  const path = join(SHARED, "languages.data.ts");
  const src = readFileSync(path, "utf8");
  const names = displayNames("language");
  let added = 0;
  // A row is `{ code, label: {…}, asr, gen }`, on one line or wrapped by
  // Prettier over several; only the label object is rewritten.
  const next = src.replace(
    /(\{\s*code: "([a-z]+)",\s*label: )\{([^}]*)\}/g,
    (_, head, code, body) => {
      const done = complete(parseNames(body), code, names, "language");
      added += done.added;
      return `${head}${render(done.out)}`;
    },
  );
  writeFileSync(path, next);
  console.log(`languages.data.ts: ${added} names added`);
}

// Leave both tables the way the formatter wants them, so a regenerated file is
// not also a formatting diff.
{
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "pnpm",
    [
      "exec",
      "prettier",
      "--write",
      "packages/shared/src/country-names.ts",
      "packages/shared/src/languages.data.ts",
    ],
    { cwd: root, stdio: "ignore" },
  );
}
