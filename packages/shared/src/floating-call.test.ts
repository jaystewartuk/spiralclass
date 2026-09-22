import { describe, expect, it } from "vitest";
import {
  FLOATING_CALL_HEIGHT,
  FLOATING_CALL_WIDTH,
  floatingCornerPosition,
  nearestFloatingCorner,
  snapToNearestCorner,
  type FloatingBounds,
} from "./floating-call";

const bounds: FloatingBounds = {
  width: 400,
  height: 800,
  tileWidth: FLOATING_CALL_WIDTH,
  tileHeight: FLOATING_CALL_HEIGHT,
  margin: 12,
};

describe("floatingCornerPosition", () => {
  it("places each corner flush against its edges, honoring the margin", () => {
    expect(floatingCornerPosition("top-left", bounds)).toEqual({ x: 12, y: 12 });
    expect(floatingCornerPosition("top-right", bounds)).toEqual({
      x: 400 - FLOATING_CALL_WIDTH - 12,
      y: 12,
    });
    expect(floatingCornerPosition("bottom-left", bounds)).toEqual({
      x: 12,
      y: 800 - FLOATING_CALL_HEIGHT - 12,
    });
    expect(floatingCornerPosition("bottom-right", bounds)).toEqual({
      x: 400 - FLOATING_CALL_WIDTH - 12,
      y: 800 - FLOATING_CALL_HEIGHT - 12,
    });
  });

  it("honors top/bottom insets so a bubble never lands under a bar", () => {
    const withInsets: FloatingBounds = { ...bounds, topInset: 40, bottomInset: 90 };
    expect(floatingCornerPosition("top-left", withInsets)).toEqual({ x: 12, y: 52 });
    expect(floatingCornerPosition("bottom-left", withInsets).y).toBe(
      800 - FLOATING_CALL_HEIGHT - 12 - 90,
    );
  });

  it("never produces a negative position on a container smaller than the tile", () => {
    const tiny: FloatingBounds = {
      width: 50,
      height: 50,
      tileWidth: 120,
      tileHeight: 160,
      margin: 12,
    };
    const pos = floatingCornerPosition("bottom-right", tiny);
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
  });
});

describe("nearestFloatingCorner", () => {
  it("resolves to the quadrant the bubble's center falls in", () => {
    expect(nearestFloatingCorner({ x: 0, y: 0 }, bounds)).toBe("top-left");
    expect(nearestFloatingCorner({ x: 400 - FLOATING_CALL_WIDTH, y: 0 }, bounds)).toBe("top-right");
    expect(nearestFloatingCorner({ x: 0, y: 800 - FLOATING_CALL_HEIGHT }, bounds)).toBe(
      "bottom-left",
    );
    expect(
      nearestFloatingCorner(
        { x: 400 - FLOATING_CALL_WIDTH, y: 800 - FLOATING_CALL_HEIGHT },
        bounds,
      ),
    ).toBe("bottom-right");
  });

  it("resolves a dead-center drag deterministically rather than throwing/undefined", () => {
    const center = {
      x: bounds.width / 2 - FLOATING_CALL_WIDTH / 2,
      y: bounds.height / 2 - FLOATING_CALL_HEIGHT / 2,
    };
    expect(["top-left", "top-right", "bottom-left", "bottom-right"]).toContain(
      nearestFloatingCorner(center, bounds),
    );
  });
});

describe("snapToNearestCorner", () => {
  it("snaps a position dragged near the top-right into the top-right corner", () => {
    const dragged = { x: 350, y: 40 };
    expect(snapToNearestCorner(dragged, bounds)).toEqual({
      x: 400 - FLOATING_CALL_WIDTH - 12,
      y: 12,
      corner: "top-right",
    });
  });

  it("snaps a position dragged near the bottom-left into the bottom-left corner", () => {
    const dragged = { x: 5, y: 750 };
    expect(snapToNearestCorner(dragged, bounds)).toEqual({
      x: 12,
      y: 800 - FLOATING_CALL_HEIGHT - 12,
      corner: "bottom-left",
    });
  });
});
