import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs build script with no type declarations.
import { catalogChunkFailures, languageFingerprints } from "../../scripts/catalog-chunks.mjs";

// The build check that keeps each language in its own client chunk (#178),
// exercised against made-up catalogs and chunks: the real build is the heavy
// tier's (scripts/check-build-output.mjs, after `next build`).

const SENTENCES = {
  en: [
    "Your booking page is the one link you share with every new student",
    "A student who pays through Stripe pays the teacher directly, never us",
    "Working hours are the times your students can book a class with you",
    "Every class you teach is listed here with the student and the package",
  ],
  fr: [
    "Votre page de réservation est le seul lien à partager avec vos élèves",
    "Un élève qui paie avec Stripe paie directement le professeur, jamais nous",
    "Vos horaires de travail sont les heures où vos élèves peuvent réserver",
    "Chaque cours que vous donnez apparaît ici avec l’élève et son forfait",
  ],
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(chunks: Record<string, string>) {
  dir = mkdtempSync(join(tmpdir(), "catalog-chunks-"));
  const catalogs = join(dir, "i18n");
  const statics = join(dir, "static", "chunks");
  mkdirSync(catalogs, { recursive: true });
  mkdirSync(statics, { recursive: true });
  for (const [locale, sentences] of Object.entries(SENTENCES)) {
    const body = sentences.map((s, i) => `  "key.${i}": "${s}",`).join("\n");
    writeFileSync(
      join(catalogs, `catalog.${locale}.ts`),
      `export const ${locale} = {\n${body}\n};\n`,
    );
  }
  for (const [name, contents] of Object.entries(chunks)) {
    writeFileSync(join(statics, name), contents);
  }
  return { statics: join(dir, "static"), catalogs };
}

// A chunk as a minifier writes one: the strings, in some object, among code.
const chunkOf = (...locales: (keyof typeof SENTENCES)[]) =>
  `(self.TURBOPACK=[]).push([${locales
    .map((l) => `{${SENTENCES[l].map((s, i) => `"k${i}":"${s}"`).join(",")}}`)
    .join(",")}]);`;

describe("catalogChunkFailures", () => {
  it("passes when each language is in a chunk of its own", () => {
    const { statics, catalogs } = fixture({ "a.js": chunkOf("en"), "b.js": chunkOf("fr") });
    expect(catalogChunkFailures(statics, catalogs)).toEqual([]);
  });

  it("fails a chunk that carries two languages, naming them", () => {
    const { statics, catalogs } = fixture({ "a.js": chunkOf("en", "fr") });
    const failures = catalogChunkFailures(statics, catalogs);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("2 languages' strings (en, fr)");
  });

  it("fails when a language is in no chunk, rather than passing on nothing seen", () => {
    const { statics, catalogs } = fixture({ "a.js": chunkOf("en") });
    expect(catalogChunkFailures(statics, catalogs)).toEqual([
      expect.stringContaining("No client chunk carries fr's strings"),
    ]);
  });

  it("does not count a stray sentence or two as a language", () => {
    const stray = `console.log("${SENTENCES.fr[0]}");`;
    const { statics, catalogs } = fixture({
      "a.js": chunkOf("en") + stray,
      "b.js": chunkOf("fr"),
    });
    expect(catalogChunkFailures(statics, catalogs)).toEqual([]);
  });
});

describe("languageFingerprints, over the real catalogs", () => {
  it("finds enough sentences to recognise every language", () => {
    const real = languageFingerprints(join(__dirname, "../../../../packages/shared/src/i18n"));
    expect(Object.keys(real).sort()).toEqual(["en", "es", "fr"]);
    for (const prints of Object.values(real) as string[][]) {
      expect(prints.length).toBeGreaterThanOrEqual(3);
    }
  });
});
