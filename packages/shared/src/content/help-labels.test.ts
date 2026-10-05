import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strings } from "../i18n/catalog";
import type { AppLocale } from "../i18n/locales";

// A help guide names what is on screen in **bold**: a button, a tab, a page,
// "Settings → Packages". The English guides named eight things the app does
// not show — "Sign in with Google" for "Continue with Google", "Templates" for
// "Packages" — so a reader looked for a button that does not exist, and the
// Spanish and French guides inherited it. A bold label must be text the app
// shows, in that guide's language.

const HELP = join(__dirname, "..", "..", "..", "..", "docs", "help");

/** Bold runs that are not interface labels: emphasis, said here. */
const NOT_A_LABEL = new Set(["every"]);

/** Bold runs that are sentences (troubleshooting headings, FAQ questions) or
 *  quoted titles (suggested videos) rather than labels. */
const isProse = (run: string) => /[.?!¿¡]$|["“”«»]/.test(run) || run.split(/\s+/).length > 7;

const normalize = (s: string) =>
  s
    .replace(/[.…:]$/, "")
    .replace(/’/g, "'")
    .trim();

function catalogValues(locale: AppLocale): Set<string> {
  return new Set(Object.values(strings[locale] as Record<string, string>).map((v) => normalize(v)));
}

/** Nav labels the app renders from packages/shared/src/nav.ts, not the catalog. */
async function navLabels(locale: AppLocale): Promise<string[]> {
  const nav = await import("../nav");
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record[locale] === "string") found.push(record[locale] as string);
      for (const v of Object.values(record)) walk(v);
    }
  };
  walk(nav);
  return found.map(normalize);
}

function guideFiles(audience: string, locale: AppLocale): string[] {
  const pattern =
    locale === "en" ? /^[a-z0-9-]+\.md$/ : new RegExp(`^[a-z0-9-]+\\.${locale}\\.md$`);
  return readdirSync(join(HELP, audience)).filter((f) => pattern.test(f));
}

describe.each(["en", "es", "fr"] as const)("help guides in %s", (locale) => {
  it("name only labels the app shows in that language", async () => {
    const known = new Set([...catalogValues(locale), ...(await navLabels(locale))]);
    const unknown: string[] = [];
    for (const audience of ["teacher", "student"]) {
      for (const file of guideFiles(audience, locale)) {
        const text = readFileSync(join(HELP, audience, file), "utf8");
        for (const [, run] of text.matchAll(/\*\*([^*]+)\*\*/g)) {
          const label = run.trim();
          if (isProse(label) || NOT_A_LABEL.has(label)) continue;
          for (const part of label.split(/\s*→\s*/).map(normalize)) {
            if (!known.has(part)) unknown.push(`${audience}/${file}: **${label}** (“${part}”)`);
          }
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
