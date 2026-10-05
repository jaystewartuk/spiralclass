import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOSSARY } from "../i18n/glossary";
import type { AppLocale } from "../i18n/locales";

// The help centre's translations (#178 step A7). Each is a person-reviewed
// file beside its English guide; these hold them to the English one's shape,
// to their language's glossary, and to completeness.

const HELP = join(__dirname, "..", "..", "..", "..", "docs", "help");
const AUDIENCES = ["teacher", "student"] as const;

/** Languages whose help centre is complete: every guide, and the index. */
const COMPLETE: readonly AppLocale[] = ["es", "fr"];

const read = (audience: string, file: string) => readFileSync(join(HELP, audience, file), "utf8");
const englishFiles = (audience: string) =>
  readdirSync(join(HELP, audience)).filter((f) => /^[a-z0-9-]+\.md$/.test(f));
const sections = (md: string) => md.match(/^##\s+/gm)?.length ?? 0;
const linkTargets = (md: string) => [...md.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
/** A guide link with its language suffix removed: `faq.es.md` → `faq.md`. */
const unlocalized = (target: string) => target.replace(/^([a-z0-9-]+)\.[a-z]{2}\.md$/, "$1.md");

describe("help-centre translations", () => {
  for (const audience of AUDIENCES) {
    for (const locale of COMPLETE) {
      it(`${audience}: every guide exists in ${locale}`, () => {
        const missing = englishFiles(audience)
          .map((f) => f.replace(/\.md$/, `.${locale}.md`))
          .filter((f) => !readdirSync(join(HELP, audience)).includes(f));
        expect(missing).toEqual([]);
      });
    }

    for (const english of englishFiles(audience)) {
      for (const locale of COMPLETE) {
        const translated = english.replace(/\.md$/, `.${locale}.md`);
        it(`${audience}/${translated} has the English guide's sections and links`, () => {
          const en = read(audience, english);
          const tr = read(audience, translated);
          expect(sections(tr), "## sections").toBe(sections(en));
          expect(tr.match(/^#\s+/gm)?.length, "one H1").toBe(1);
          expect(linkTargets(tr).map(unlocalized), "link targets, in order").toEqual(
            linkTargets(en),
          );
          // A reader browsing the docs in this language stays in it: a link to
          // another guide is to that guide's own translation.
          const toEnglish = linkTargets(tr).filter((t) => /^[a-z0-9-]+\.md$/.test(t));
          expect(toEnglish, `links to the English guide instead of the ${locale} one`).toEqual([]);
        });

        it(`${audience}/${translated} keeps to the ${locale} glossary`, () => {
          const tr = read(audience, translated);
          for (const { pattern, why } of GLOSSARY[locale].forbidden) {
            expect(tr.match(pattern)?.[0], `${pattern} — ${why}`).toBeUndefined();
          }
        });
      }
    }
  }
});
