import { describe, expect, it } from "vitest";
import { helpGuideId, helpSectionId, slugifyAnchor } from "./anchors";

describe("slugifyAnchor", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyAnchor("Before you start")).toBe("before-you-start");
  });

  it("folds diacritics rather than dropping the letter", () => {
    expect(slugifyAnchor("Propósito")).toBe("proposito");
    expect(slugifyAnchor("Solución de problemas")).toBe("solucion-de-problemas");
  });

  it("collapses punctuation and trims the edges", () => {
    expect(slugifyAnchor("  What it costs you — to get paid!  ")).toBe(
      "what-it-costs-you-to-get-paid",
    );
  });

  it("returns an empty string for a heading with no word characters", () => {
    expect(slugifyAnchor("—")).toBe("");
  });
});

describe("help anchor ids", () => {
  it("namespaces a section by its guide, so four `Purpose` headings stay distinct", () => {
    const a = helpSectionId("getting-started", "Purpose", 0);
    const b = helpSectionId("packages-and-payments", "Purpose", 0);
    expect(a).not.toBe(b);
    expect(a).toBe("guide-getting-started-purpose");
  });

  it("falls back to the section position when a heading slugifies to nothing", () => {
    expect(helpSectionId("faq", "—", 2)).toBe("guide-faq-section-3");
  });

  it("prefixes guide ids so they cannot collide with anything else on the page", () => {
    expect(helpGuideId("live-calls")).toBe("guide-live-calls");
  });
});
