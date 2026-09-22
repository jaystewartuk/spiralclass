import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_CODE_LICENCE, SOURCE_CODE_URL } from "./source-code";
import { strings } from "./i18n/catalog";
import { LOCALES } from "./i18n/locales";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("the source-code claim the marketing site makes", () => {
  it("points at an https GitHub repository", () => {
    expect(SOURCE_CODE_URL).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });

  // The /about card says "under the {licence} licence" and the licence comes
  // from this constant, so a relicence that misses it would have the site
  // stating the wrong terms in three languages. package.json is the value the
  // repository actually publishes under.
  it("names the licence the repository actually ships under", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      license?: string;
    };
    expect(SOURCE_CODE_LICENCE).toBe(pkg.license);
  });

  // Both surfaces that carry the claim need copy in every locale, and the
  // licence must arrive by interpolation rather than be typed into a
  // translation — a hardcoded "AGPL-3.0-only" in one locale is exactly the
  // drift the constant exists to prevent.
  for (const locale of LOCALES) {
    it(`ships the open-source copy in ${locale.tag}, with the licence interpolated`, () => {
      const catalog = strings[locale.tag] as Record<string, string>;
      expect(catalog["web.siteFooter.sourceCode"]).toBeTruthy();
      expect(catalog["web.about.trust.openSource.title"]).toBeTruthy();
      expect(catalog["web.about.trust.openSource.link"]).toBeTruthy();

      const body = catalog["web.about.trust.openSource.body"];
      expect(body).toContain("{licence}");
      expect(body).not.toContain(SOURCE_CODE_LICENCE);
    });
  }
});
