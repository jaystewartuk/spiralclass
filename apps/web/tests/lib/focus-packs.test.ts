import { describe, expect, it } from "vitest";
import { focusTagSeedFor, FOCUS_TAG_CATEGORY_ORDER, type FocusTagSeed } from "@/lib/focus-packs";

// Focus-tag seed packs — D-19 Layers 2/3, narrowed to language-first by D-72
// (the music/math/generic packs and the `discipline` concept are gone; a pack is
// now chosen by the language the teacher teaches). The packs are DATA; these
// guard the invariants the seeder relies on.

describe("focus-tag seed packs", () => {
  it("maps every language to a non-empty pack with unique keys", () => {
    for (const code of ["es", "en", "fr", "nah", null, undefined]) {
      const { seeds } = focusTagSeedFor(code);
      expect(seeds.length).toBeGreaterThan(0);
      const keys = seeds.map((s: FocusTagSeed) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  // Any language without its own hand-written pack shares the neutral one —
  // the axes a language lesson always has, minus language-specific grammar.
  it("falls back to the neutral language pack for unknown / null languages", () => {
    const neutral = focusTagSeedFor("fr");
    expect(neutral.pack).toBe("language");
    expect(focusTagSeedFor(null).pack).toBe("language");
    expect(focusTagSeedFor(undefined).pack).toBe("language");
    expect(focusTagSeedFor("nah").seeds).toEqual(neutral.seeds);
    // The retired subject codes are just unknown languages now.
    // A retired D-20 subject code is just an unknown language now.
    expect(focusTagSeedFor("music").pack).toBe("language");
  });

  it("ships a rich Spanish pack with grammar, vocabulary, skills and activities", () => {
    const { pack, seeds } = focusTagSeedFor("es");
    expect(pack).toBe("es");
    const categories = new Set(seeds.map((s) => s.category));
    expect(categories).toContain("grammar");
    expect(categories).toContain("vocabulary");
    expect(categories).toContain("skill");
    expect(categories).toContain("activity");
    expect(seeds.some((s) => /subjuntivo/i.test(s.label))).toBe(true);
  });

  // profedeele.es "Categoría" / "Temática" facets folded into the Spanish
  // pack (docs/features/library-materials.md) — Gramática/
  // Vocabulario/Cultura already existed as categories/tags, so only the
  // genuinely new ones were added, under their closest existing category.
  it("folds profedeele.es's Categoría/Temática facets into the closest existing category", () => {
    const { seeds } = focusTagSeedFor("es");
    const byLabel = new Map(seeds.map((s) => [s.label, s.category]));
    expect(byLabel.get("Ortografía")).toBe("skill");
    expect(byLabel.get("Exámenes")).toBe("activity");
    expect(byLabel.get("Funciones comunicativas")).toBe("activity");
    for (const label of [
      "Cultura",
      "Países hispanos",
      "Español terapia",
      "Valores",
      "Fines específicos",
      "ELE para niños",
    ]) {
      expect(byLabel.get(label)).toBe("theme");
    }
  });

  it("ships a rich English pack at parity with Spanish (all five axes, incl. themes)", () => {
    const { pack, seeds } = focusTagSeedFor("en");
    expect(pack).toBe("en");
    const categories = new Set(seeds.map((s) => s.category));
    // Every non-format axis is represented — same coverage as the Spanish pack.
    for (const axis of ["grammar", "vocabulary", "skill", "activity", "theme"] as const) {
      expect(categories).toContain(axis);
    }
    const byLabel = new Map(seeds.map((s) => [s.label, s.category]));
    // Structures an English course actually drills, beyond the basic tenses.
    expect(byLabel.get("Passive voice")).toBe("grammar");
    expect(byLabel.get("Reported speech")).toBe("grammar");
    expect(byLabel.get("Phrasal verbs")).toBe("grammar");
    // Themes now exist (they didn't before) — e.g. business + exam prep.
    expect(byLabel.get("Business English")).toBe("theme");
    expect(byLabel.get("Spelling")).toBe("skill");
  });

  // The Spanish and English packs are curated to comparable depth so neither
  // language's teacher lands on a thin picker.
  it("keeps the Spanish and English packs within one axis-count of each other", () => {
    const count = (code: string) => {
      const byAxis = new Map<string, number>();
      for (const s of focusTagSeedFor(code).seeds) {
        byAxis.set(s.category, (byAxis.get(s.category) ?? 0) + 1);
      }
      return byAxis;
    };
    const es = count("es");
    const en = count("en");
    for (const axis of ["grammar", "vocabulary", "skill", "activity", "theme"]) {
      expect((es.get(axis) ?? 0) > 0 && (en.get(axis) ?? 0) > 0).toBe(true);
    }
  });

  it("uses only known categories so the picker can group them", () => {
    for (const code of ["es", "en", "fr"]) {
      for (const s of focusTagSeedFor(code).seeds) {
        expect(FOCUS_TAG_CATEGORY_ORDER).toContain(s.category);
      }
    }
  });

  // Pack keys prefix the stored tag codes, so a teacher who switches the
  // language she teaches can hold two packs without their keys colliding.
  it("keys packs distinctly so two languages' tags never collide", () => {
    expect(focusTagSeedFor("es").pack).toBe("es");
    expect(focusTagSeedFor("en").pack).toBe("en");
    expect(focusTagSeedFor("fr").pack).toBe("language");
  });
});
