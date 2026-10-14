import { describe, expect, it } from "vitest";
import {
  SELFVIEW_H,
  SELFVIEW_MARGIN,
  SELFVIEW_W,
  clampSelfViewPosition,
  initialFloatingTilePosition,
  isTapGesture,
  TAP_MAX_DURATION_MS,
  TAP_MOVE_THRESHOLD_PX,
} from "./call-drag";

const bounds = { screenW: 400, screenH: 800, controlsBlockH: 120 };

describe("initialFloatingTilePosition", () => {
  it("anchors right for the right corner", () => {
    const pos = initialFloatingTilePosition(bounds, "right");
    expect(pos.x).toBe(bounds.screenW - SELFVIEW_W - SELFVIEW_MARGIN);
  });

  it("anchors left for the left corner", () => {
    const pos = initialFloatingTilePosition(bounds, "left");
    expect(pos.x).toBe(SELFVIEW_MARGIN);
  });

  it("stays above the controls bar for both corners", () => {
    const expectedY = bounds.screenH - SELFVIEW_H - bounds.controlsBlockH - SELFVIEW_MARGIN;
    expect(initialFloatingTilePosition(bounds, "left").y).toBe(expectedY);
    expect(initialFloatingTilePosition(bounds, "right").y).toBe(expectedY);
  });
});

describe("clampSelfViewPosition", () => {
  it("keeps a plain move within bounds unmodified", () => {
    const pos = clampSelfViewPosition({ x: 100, y: 100 }, { dx: 10, dy: -10 }, bounds);
    expect(pos).toEqual({ x: 110, y: 90 });
  });

  it("clamps to the left/top margin", () => {
    const pos = clampSelfViewPosition({ x: 20, y: 20 }, { dx: -1000, dy: -1000 }, bounds);
    expect(pos).toEqual({ x: SELFVIEW_MARGIN, y: SELFVIEW_MARGIN });
  });

  it("clamps to the right/bottom margin, above the controls bar", () => {
    const pos = clampSelfViewPosition({ x: 20, y: 20 }, { dx: 10000, dy: 10000 }, bounds);
    expect(pos).toEqual({
      x: bounds.screenW - SELFVIEW_W - SELFVIEW_MARGIN,
      y: bounds.screenH - SELFVIEW_H - bounds.controlsBlockH - SELFVIEW_MARGIN,
    });
  });
});

describe("isTapGesture", () => {
  it("is a tap when the gesture barely moved and released quickly", () => {
    expect(isTapGesture({ dx: 0, dy: 0 }, 100)).toBe(true);
    expect(isTapGesture({ dx: 2, dy: 1 }, 50)).toBe(true);
  });

  it("is NOT a tap once the movement exceeds the threshold — it's a drag", () => {
    expect(isTapGesture({ dx: TAP_MOVE_THRESHOLD_PX + 1, dy: 0 }, 50)).toBe(false);
    expect(isTapGesture({ dx: 20, dy: 20 }, 50)).toBe(false);
  });

  it("is NOT a tap once held past the max duration, even with no movement", () => {
    expect(isTapGesture({ dx: 0, dy: 0 }, TAP_MAX_DURATION_MS + 1)).toBe(false);
  });
});
