import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@spiralclass/shared";
import { navIcon } from "./nav-icons";

describe("nav icons", () => {
  it("has an icon for every non-legal nav destination", () => {
    // privacy/terms are plain external legal links in the account menu — no
    // icon needed there, everything else renders as an icon + label row in
    // the mobile drawer and the tablet sidebar (app-nav.tsx).
    const exempt = new Set(["privacy", "terms"]);
    const missing = NAV_ITEMS.filter((item) => !exempt.has(item.key) && !navIcon(item.key)).map(
      (item) => item.key,
    );
    expect(missing).toEqual([]);
  });

  it("gives every icon a distinct destination (no two nav rows share a glyph)", () => {
    // Repeated icons defeat the point of scanning a list by shape — two
    // adjacent rows with the same glyph read as duplicates at a glance.
    const seen = new Map<unknown, string>();
    for (const item of NAV_ITEMS) {
      const icon = navIcon(item.key);
      if (!icon) continue;
      const clash = seen.get(icon);
      expect(clash, `${item.key} reuses ${clash}'s icon`).toBeUndefined();
      seen.set(icon, item.key);
    }
  });
});
