import { describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_TILE_KEYS,
  NAV_GROUP_LABELS,
  NAV_ITEMS,
  navDescription,
  navGroup,
  navItem,
  navLabel,
  resolveDashboardTiles,
  TEACHER_PRIMARY_TAB_KEYS,
  type DashboardTilePref,
  type NavGroupKey,
} from "./nav";

describe("nav model", () => {
  it("has unique keys", () => {
    const keys = NAV_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every item bilingual labels", () => {
    for (const item of NAV_ITEMS) {
      expect(item.label["es-MX"].length).toBeGreaterThan(0);
      expect(item.label.en.length).toBeGreaterThan(0);
    }
  });

  it("assigns every item to a known group", () => {
    const groups: NavGroupKey[] = ["main", "page", "content", "config", "support"];
    for (const item of NAV_ITEMS) {
      expect(groups).toContain(item.group);
      expect(NAV_GROUP_LABELS[item.group]).toBeDefined();
    }
  });

  it("homes the page editor, leads and testimonials under 'Tu página'", () => {
    const pageKeys = navGroup("page").map((i) => i.key);
    expect(pageKeys).toContain("leads");
    expect(pageKeys).toContain("testimonials");
    // The page editor (`bookingPage`) belongs with "your page", not settings —
    // and it leads the group.
    expect(pageKeys[0]).toBe("bookingPage");
    expect(navGroup("config").map((i) => i.key)).not.toContain("bookingPage");
    // Materials moved to the class-content cluster in config.
    expect(pageKeys).not.toContain("materials");
  });

  it("promotes the class-content surfaces into their own 'Materiales' group", () => {
    const contentKeys = navGroup("content").map((i) => i.key);
    // The teaching-content surfaces are their own group now, in order — not
    // buried in config. `materialStyle` (D-78) joins them: the AI-material
    // tone/style settings sit with the surfaces that feed the AI engine.
    expect(contentKeys).toEqual([
      "materials",
      "focusTags",
      "classContentTemplates",
      "materialStyle",
    ]);
    // And they're gone from config.
    const configKeys = navGroup("config").map((i) => i.key);
    expect(configKeys).not.toContain("materials");
    expect(configKeys).not.toContain("focusTags");
    expect(configKeys).not.toContain("classContentTemplates");
    // The group carries a bilingual label. Relabeled from "Contenido"/"Content"
    // — that collided with the per-class "Contenido de la
    // clase" ("Class content") panel title elsewhere in the product.
    expect(NAV_GROUP_LABELS.content["es-MX"]).toBe("Materiales");
    expect(NAV_GROUP_LABELS.content.en).toBe("Materials");
  });

  it("navGroup returns items in declaration order", () => {
    const principal = navGroup("main").map((i) => i.key);
    expect(principal[0]).toBe("dashboard");
    expect(principal).toEqual([
      "dashboard",
      "calendar",
      "classes",
      "students",
      "payments",
      "messages",
      // D-125: the student-acquisition command centre is a main-group
      // destination, not a settings screen — burying acquisition under "Tu
      // página" is why the features that already existed went unused.
      "getStudents",
    ]);
  });

  it("defines the primary tab-bar set in order, all from the main group", () => {
    expect(TEACHER_PRIMARY_TAB_KEYS).toEqual(["dashboard", "classes", "payments", "messages"]);
    const mainKeys = navGroup("main").map((i) => i.key);
    for (const key of TEACHER_PRIMARY_TAB_KEYS) {
      // Each tab is a real, resolvable destination in the main task group, so
      // web and mobile can both render it from the shared definition.
      expect(mainKeys).toContain(key);
      expect(() => navItem(key)).not.toThrow();
    }
  });

  it("navItem throws on an unknown key", () => {
    // @ts-expect-error — exercising the runtime guard with an invalid key.
    expect(() => navItem("nope")).toThrow(/Unknown nav key/);
  });

  it("resolves labels and descriptions by locale with an English fallback", () => {
    const leads = navItem("leads");
    expect(navLabel(leads, "es-MX")).toBe("Interesados");
    expect(navLabel(leads, "en")).toBe("Leads");
    expect(navDescription(leads, "en")).toMatch(/booking page/);

    const calendar = navItem("calendar");
    expect(navDescription(calendar, "en")).toBeUndefined();
  });
});

describe("resolveDashboardTiles", () => {
  it("returns the default order, nothing hidden, when never customized", () => {
    expect(resolveDashboardTiles(null)).toEqual(
      DEFAULT_DASHBOARD_TILE_KEYS.map((key) => ({ key, hidden: false })),
    );
    expect(resolveDashboardTiles(undefined)).toEqual(
      DEFAULT_DASHBOARD_TILE_KEYS.map((key) => ({ key, hidden: false })),
    );
  });

  it("honours a saved order and hidden flags", () => {
    const saved = [
      { key: "payments" as const, hidden: false },
      { key: "classes" as const, hidden: true },
    ];
    const resolved = resolveDashboardTiles(saved);
    expect(resolved[0]).toEqual({ key: "payments", hidden: false });
    expect(resolved[1]).toEqual({ key: "classes", hidden: true });
    // Every default key still appears exactly once.
    expect(resolved.map((t) => t.key).sort()).toEqual([...DEFAULT_DASHBOARD_TILE_KEYS].sort());
  });

  it("drops unknown/stale keys and de-dupes, then appends missing defaults", () => {
    const saved: DashboardTilePref[] = [
      { key: "classes", hidden: false },
      // @ts-expect-error — exercising the runtime filter against a stale key.
      { key: "retiredFeature", hidden: false },
      { key: "classes", hidden: true }, // duplicate — first wins
    ];
    const resolved = resolveDashboardTiles(saved);
    expect(resolved[0]).toEqual({ key: "classes", hidden: false });
    expect(resolved.map((t) => t.key).sort()).toEqual([...DEFAULT_DASHBOARD_TILE_KEYS].sort());
  });
});
