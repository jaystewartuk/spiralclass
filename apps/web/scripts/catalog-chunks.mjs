/**
 * Every language's strings in a client chunk of their own (#178).
 *
 * The browser used to download every language on every page — 400 kB gzipped
 * across three, of which a reader uses one — because the client provider
 * imported the whole catalog. It now loads one language's table through its own
 * `import()` (apps/web/src/components/locale-catalog/). Two things undo that
 * silently, and both type-check, lint and pass every unit test:
 *
 *   - a Client Component, or anything it imports, reaching `createT` or
 *     `strings`, which puts every language back into a shared chunk;
 *   - the per-language modules being imported statically, which the bundler
 *     groups into one chunk whichever of them a page renders.
 *
 * Only the built chunks can say which happened, so this reads them. A language
 * is recognised by fingerprints drawn from its own catalog file — sentences no
 * other language's catalog contains — so a new catalog.<locale>.ts is covered
 * without touching this file. And it fails when a language is found in NO
 * chunk: a fingerprint the minifier rewrote would otherwise pass by matching
 * nothing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** How many fingerprints per language, and how many make a match. */
const FINGERPRINTS = 8;
const MATCH = 3;

/** Catalog values that survive minification byte-for-byte: no quote, escape,
 * brace or newline for the minifier to rewrite, and long enough to be unique. */
function fingerprintable(value) {
  return value.length >= 40 && !/["'`\\{}\n]/.test(value);
}

function catalogValues(file) {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^\s*"[\w.]+":\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)",?\s*$/gm)].map(
    (m) => m[1],
  );
}

/** `{ fr: [...sentences], ... }`, one entry per catalog.<locale>.ts. */
export function languageFingerprints(catalogDir) {
  const values = {};
  for (const file of readdirSync(catalogDir)) {
    const match = /^catalog\.([a-zA-Z-]+)\.ts$/.exec(file);
    if (match) values[match[1]] = catalogValues(join(catalogDir, file));
  }
  const fingerprints = {};
  for (const [locale, own] of Object.entries(values)) {
    const others = new Set(
      Object.entries(values)
        .filter(([other]) => other !== locale)
        .flatMap(([, v]) => v),
    );
    fingerprints[locale] = own
      .filter((value) => fingerprintable(value) && !others.has(value))
      .sort((a, b) => b.length - a.length)
      .slice(0, FINGERPRINTS);
  }
  return fingerprints;
}

function* chunks(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* chunks(full);
    else if (entry.endsWith(".js")) yield full;
  }
}

/** Failure messages; empty when every chunk holds at most one language and
 * every language is in some chunk. */
export function catalogChunkFailures(staticDir, catalogDir) {
  const fingerprints = languageFingerprints(catalogDir);
  const failures = [];
  const found = new Set();

  for (const [locale, prints] of Object.entries(fingerprints)) {
    if (prints.length < MATCH) {
      failures.push(
        `catalog.${locale}.ts has only ${prints.length} sentence(s) usable as a fingerprint; ` +
          `the language check cannot recognise it.`,
      );
    }
  }

  for (const chunk of chunks(staticDir)) {
    const contents = readFileSync(chunk, "utf8");
    const languages = Object.entries(fingerprints)
      .filter(([, prints]) => prints.filter((p) => contents.includes(p)).length >= MATCH)
      .map(([locale]) => locale);
    for (const locale of languages) found.add(locale);
    if (languages.length > 1) {
      failures.push(
        `${chunk} carries ${languages.length} languages' strings (${languages.join(", ")}). ` +
          `Every reader downloads all of them. A Client Component, or something it imports, ` +
          `reaches the full catalog (createT, strings, isStringKey, issueMessage) — pass it the ` +
          `reader's \`t\` from useT() instead — or a per-language module in ` +
          `src/components/locale-catalog/ is imported statically rather than by import().`,
      );
    }
  }

  for (const locale of Object.keys(fingerprints)) {
    if (!found.has(locale)) {
      failures.push(
        `No client chunk carries ${locale}'s strings. Either the language is never loaded in ` +
          `the browser, or its fingerprints no longer survive minification and this check ` +
          `has stopped seeing anything.`,
      );
    }
  }
  return failures;
}
