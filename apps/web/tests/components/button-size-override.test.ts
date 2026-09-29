import { describe, expect, it } from "vitest";
import { buttonClassName } from "@/components/ui/button";

// twMerge only replaces a utility with one of the same variant, so a caller's
// `h-auto` used to leave the size variant's `lg:h-10` in place. Every collapsed
// package card on /settings/templates was a Button with `h-auto` and a
// two-line summary — pinned at 40px on desktop, with its second line running
// out over the card's border.
describe("buttonClassName — the caller's height and width win at every breakpoint", () => {
  it("drops the variant's responsive height when the caller sets a height", () => {
    const classes = buttonClassName({ variant: "ghost", className: "h-auto" }).split(" ");
    expect(classes).toContain("h-auto");
    expect(classes).not.toContain("lg:h-10");
    expect(classes).not.toContain("h-11");
  });

  it("drops the variant's responsive width when the caller sets a width", () => {
    const classes = buttonClassName({ size: "icon", className: "w-auto" }).split(" ");
    expect(classes).not.toContain("lg:w-10");
    // Height was not overridden, so the desktop height stays.
    expect(classes).toContain("lg:h-10");
  });

  it("treats size-* as both a height and a width", () => {
    const classes = buttonClassName({ size: "icon", className: "size-8" }).split(" ");
    expect(classes).not.toContain("lg:h-10");
    expect(classes).not.toContain("lg:w-10");
  });

  it("leaves the variant's sizing alone when the caller sets neither", () => {
    const classes = buttonClassName({ className: "w-full-ish mt-2" }).split(" ");
    expect(classes).toContain("h-11");
    expect(classes).toContain("lg:h-10");
  });

  it("does not mistake a hover or gap utility for a height", () => {
    const classes = buttonClassName({ className: "gap-3 hover:bg-muted" }).split(" ");
    expect(classes).toContain("lg:h-10");
  });
});
