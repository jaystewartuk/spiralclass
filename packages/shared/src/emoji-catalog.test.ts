import { describe, expect, it } from "vitest";

import { EMOJI_CATALOG } from "./emoji-catalog";

describe("EMOJI_CATALOG", () => {
  it("has multiple non-empty categories with unique keys", () => {
    expect(EMOJI_CATALOG.length).toBeGreaterThan(1);
    const keys = EMOJI_CATALOG.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const category of EMOJI_CATALOG) {
      expect(category.emoji.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate emoji within a category", () => {
    for (const category of EMOJI_CATALOG) {
      expect(new Set(category.emoji).size).toBe(category.emoji.length);
    }
  });
});
