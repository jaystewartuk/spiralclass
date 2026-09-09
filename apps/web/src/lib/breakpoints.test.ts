import { describe, expect, it } from "vitest";
import {
  CONTAINER_MAX_WIDTH,
  DESKTOP_MIN_WIDTH,
  SCREENS,
  TABLET_MAX_WIDTH,
  layoutForWidth,
} from "./breakpoints";

const px = (value: string) => Number(value.replace("px", ""));

// Real device CSS viewport widths, portrait × landscape. Kept from the D-122
// test because the devices are still the devices — what changed is what the
// scale is expected to do with them.
const PHONE_WIDTHS = [320, 390, 430, 412];
const TABLET_PORTRAIT = [744, 820, 834, 800];
const TABLET_LANDSCAPE = [
  1133, // iPad mini 6
  1180, // iPad 10th gen / Air 11"
  1194, // iPad Pro 11"
  1280, // A common Android tablet in landscape, and a width teachers really
  //       work at. Under D-122 this was one pixel under the threshold
  //       and the whole scale was built around it; under the standard scale it
  //       gets the desktop layout. See D-141 for why that is now acceptable.
];

describe("responsive screen scale", () => {
  it("keeps Tailwind's default widths, so a reader can trust what `md:` means", () => {
    expect(SCREENS.sm).toBe("640px");
    expect(SCREENS.md).toBe("768px");
    expect(SCREENS.lg).toBe("1024px");
    expect(SCREENS.xl).toBe("1280px");
    expect(SCREENS["2xl"]).toBe("1536px");
  });

  it("gates the shell layout on a fine pointer, not on width alone", () => {
    // The whole point of D-141. A width cannot tell a 1280px tablet from a
    // 1280px laptop window, and the product was getting both wrong in opposite
    // directions: the teacher's Fire HD 10 was handed the desktop layout, and a
    // MacBook with a narrow window was handed the stacked one.
    expect(SCREENS.desktop).toEqual({
      raw: "(min-width: 1024px) and (pointer: fine)",
    });
    expect(SCREENS["desktop-wide"]).toEqual({
      raw: "(min-width: 1280px) and (pointer: fine)",
    });
  });

  it("puts the pointer-aware tiers at the same widths as the plain ones", () => {
    // If these ever drift, a mouse user and a touch user get the shell at
    // different widths for no stated reason.
    expect(SCREENS.desktop.raw).toContain(SCREENS.lg);
    expect(SCREENS["desktop-wide"].raw).toContain(SCREENS.xl);
  });

  it("puts every phone width on the stacked layout", () => {
    for (const width of PHONE_WIDTHS) {
      expect(layoutForWidth(width), `${width}px must render the stacked layout`).toBe("mobile");
      expect(width, `${width}px must not reach the desktop breakpoint`).toBeLessThan(
        px(SCREENS.lg),
      );
    }
  });

  it("keeps portrait tablets on the stacked layout", () => {
    for (const width of TABLET_PORTRAIT) {
      expect(layoutForWidth(width), `${width}px portrait must stay stacked`).toBe("mobile");
    }
  });

  it("gives landscape tablets the desktop layout, which D-122 deliberately withheld", () => {
    // The reversal, asserted rather than left implicit. A landscape tablet has
    // the room for two columns and people expect it to use them; the touch
    // concern that justified withholding it is now met by target size instead
    // of by layout — see the coarse-pointer note in breakpoints.ts.
    for (const width of TABLET_LANDSCAPE) {
      expect(layoutForWidth(width), `${width}px landscape now gets the desktop layout`).toBe(
        "desktop",
      );
    }
  });

  it("still puts laptop and desktop widths on the desktop layout", () => {
    for (const width of [1366, 1440, 1512, 1536, 1920, 2560]) {
      expect(layoutForWidth(width), `${width}px must render the desktop layout`).toBe("desktop");
    }
  });

  it("treats CSS min-width as inclusive at the boundary", () => {
    expect(DESKTOP_MIN_WIDTH).toBe(TABLET_MAX_WIDTH + 1);
    expect(layoutForWidth(TABLET_MAX_WIDTH)).toBe("mobile");
    expect(layoutForWidth(DESKTOP_MIN_WIDTH)).toBe("desktop");
  });

  it("leaves the content column capped where it was", () => {
    // Independent of the breakpoint move on purpose: how wide the readable
    // column gets is a typography decision, not a device one.
    expect(CONTAINER_MAX_WIDTH).toBe("1280px");
    expect(px(CONTAINER_MAX_WIDTH)).toBeGreaterThan(TABLET_MAX_WIDTH);
  });

  it("gives the band D-122 left empty somewhere to put a layout", () => {
    // The concrete cost of the old scale: between 640 and 1281 there was no
    // breakpoint at all, so every width in that band rendered a phone layout
    // stretched across it. `md` exists again to hold the intermediate case.
    expect(px(SCREENS.md)).toBeGreaterThan(px(SCREENS.sm));
    expect(px(SCREENS.md)).toBeLessThan(px(SCREENS.lg));
  });
});
