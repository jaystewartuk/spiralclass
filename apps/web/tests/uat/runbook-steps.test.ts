import { describe, expect, it } from "vitest";
import { UAT_SECTIONS, CATEGORY_LABELS } from "@/lib/uat/runbook-steps";

// Item ids are now hand-authored (D-55's structured runbook, not derived
// from markdown document order), so a copy-paste duplicate is a real risk —
// two items sharing an id would silently share checklist-checked state.

describe("UAT_SECTIONS", () => {
  it("has unique section ids", () => {
    const ids = UAT_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique item ids across every section", () => {
    const ids = UAT_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every item id is prefixed with its own section id", () => {
    for (const section of UAT_SECTIONS) {
      for (const item of section.items) {
        expect(item.id.startsWith(`${section.id}.`)).toBe(true);
      }
    }
  });

  it("only §B and §G use the stripe action (each needs a distinct input field)", () => {
    const stripeSections = UAT_SECTIONS.filter((s) => s.action === "stripe").map((s) => s.id);
    expect(new Set(stripeSections)).toEqual(new Set(["B", "G"]));
  });

  it("categories 0 and K2 have exactly one automated action each (probe, posthog)", () => {
    expect(UAT_SECTIONS.find((s) => s.id === "0")?.action).toBe("probe");
    expect(UAT_SECTIONS.find((s) => s.id === "K2")?.action).toBe("posthog");
  });

  it("every declared category is used by at least one section", () => {
    const used = new Set(UAT_SECTIONS.map((s) => s.category));
    for (const category of Object.keys(CATEGORY_LABELS)) {
      expect(used.has(category as never), `category "${category}" has no sections`).toBe(true);
    }
  });

  it("booking-notifications is self-contained — no guest-checkout (§B) account", () => {
    const bookingNotificationSections = UAT_SECTIONS.filter(
      (s) => s.category === "booking-notifications",
    );
    expect(bookingNotificationSections.length).toBeGreaterThanOrEqual(1); // §BW
    for (const section of bookingNotificationSections) {
      for (const item of section.items) {
        expect(item.loginAs?.email).not.toBe("alumno.uat@spiralclass.com");
      }
    }
  });
});
