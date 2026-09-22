import { describe, expect, it } from "vitest";
import {
  computeStageTileStyle,
  initialFloatingTilePosition,
  isFloatingRole,
  resolveTileRole,
} from "@/lib/video/stage-layout";

describe("isFloatingRole", () => {
  it("covers both corners and neither of the non-floating roles", () => {
    // Three call sites branch on this now (drag eligibility, resetting a
    // remembered drag position, and the caption band's bottom clearance), so
    // a fifth role added without updating it would fail here rather than in
    // whichever of the three someone happened to exercise first.
    expect(isFloatingRole("floating-left")).toBe(true);
    expect(isFloatingRole("floating-right")).toBe(true);
    expect(isFloatingRole("big")).toBe(false);
    expect(isFloatingRole("hidden")).toBe(false);
  });
});

describe("resolveTileRole", () => {
  it("is big when it's the stage's primary content, regardless of floating", () => {
    expect(resolveTileRole({ isBig: true, isFloating: false, corner: "right" })).toBe("big");
    expect(resolveTileRole({ isBig: true, isFloating: true, corner: "right" })).toBe("big");
  });

  it("floats in its assigned corner when not primary but should show", () => {
    expect(resolveTileRole({ isBig: false, isFloating: true, corner: "right" })).toBe(
      "floating-right",
    );
    expect(resolveTileRole({ isBig: false, isFloating: true, corner: "left" })).toBe(
      "floating-left",
    );
  });

  it("hides when not primary and not floating", () => {
    expect(resolveTileRole({ isBig: false, isFloating: false, corner: "right" })).toBe("hidden");
  });
});

describe("computeStageTileStyle", () => {
  it("anchors big and floating-right to the SAME edges (right/bottom only) so they can animate between each other", () => {
    const big = computeStageTileStyle("big");
    const floatingRight = computeStageTileStyle("floating-right");
    // Neither role sets top/left — only right/bottom/width/height ever
    // change between them, which is what lets a CSS transition interpolate
    // smoothly instead of snapping through an unanimatable `auto`.
    expect(big.top).toBeUndefined();
    expect(big.left).toBeUndefined();
    expect(floatingRight.top).toBeUndefined();
    expect(floatingRight.left).toBeUndefined();
    expect(big.transition).toBe(floatingRight.transition);
  });

  it("keeps the floating tile above the big one via z-index", () => {
    expect(computeStageTileStyle("floating-right").zIndex as number).toBeGreaterThan(
      computeStageTileStyle("big").zIndex as number,
    );
    expect(computeStageTileStyle("floating-left").zIndex as number).toBeGreaterThan(
      computeStageTileStyle("big").zIndex as number,
    );
  });

  it("collapses the hidden role to zero size so it can never intercept a tap", () => {
    const hidden = computeStageTileStyle("hidden");
    expect(hidden.width).toBe(0);
    expect(hidden.height).toBe(0);
  });

  it("disables touch scrolling on floating tiles so a drag never scrolls the page", () => {
    expect(computeStageTileStyle("floating-right").touchAction).toBe("none");
    expect(computeStageTileStyle("floating-left").touchAction).toBe("none");
  });

  it("ignores a drag position for a non-floating role", () => {
    const style = computeStageTileStyle("big", { position: { x: 10, y: 20 } });
    expect(style.left).toBeUndefined();
    expect(style.top).toBeUndefined();
    expect(style.right).toBe(0);
  });

  it("uses an absolute left/top once a floating tile has been dragged", () => {
    const style = computeStageTileStyle("floating-right", { position: { x: 42, y: 84 } });
    expect(style.left).toBe(42);
    expect(style.top).toBe(84);
    expect(style.right).toBeUndefined();
    expect(style.bottom).toBeUndefined();
  });

  it("drops the transition while a drag is in progress, for 1:1 tracking", () => {
    const dragging = computeStageTileStyle("floating-right", {
      position: { x: 0, y: 0 },
      dragging: true,
    });
    const released = computeStageTileStyle("floating-right", {
      position: { x: 0, y: 0 },
      dragging: false,
    });
    expect(dragging.transition).toBeUndefined();
    expect(released.transition).toBeDefined();
  });

  it("falls back to the default corner anchor when no drag position is set", () => {
    const style = computeStageTileStyle("floating-left", { position: null });
    expect(style.left).toBe(16);
    expect(style.top).toBeUndefined();
    expect(style.bottom).toBe(16);
  });
});

describe("initialFloatingTilePosition", () => {
  const bounds = { screenW: 400, screenH: 800, controlsBlockH: 120 };

  it("anchors right for the right corner and left for the left corner", () => {
    expect(initialFloatingTilePosition(bounds, "right").x).toBeGreaterThan(
      initialFloatingTilePosition(bounds, "left").x,
    );
    expect(initialFloatingTilePosition(bounds, "left").x).toBe(16);
  });

  it("stays above the controls bar", () => {
    const pos = initialFloatingTilePosition(bounds, "right");
    expect(pos.y).toBeLessThan(bounds.screenH - bounds.controlsBlockH);
  });
});
