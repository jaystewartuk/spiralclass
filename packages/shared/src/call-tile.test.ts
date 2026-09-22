import { describe, expect, it } from "vitest";
import {
  CALL_TILE_WIDTH,
  CALL_TILE_HEIGHT,
  CALL_TILE_ASPECT,
  CALL_TILE_IS_PORTRAIT,
} from "./call-tile";

// These numbers are the single source of truth for BOTH the mobile self-view
// (laid out in px) and the web self-view (CSS aspect-ratio derived from them).
// The web tile was landscape while mobile was portrait for as long as the two
// owned separate copies — these assertions fail loudly if a future edit flips
// the orientation or lets the derived aspect string fall out of step.
describe("call tile geometry", () => {
  it("is portrait (taller than wide)", () => {
    expect(CALL_TILE_HEIGHT).toBeGreaterThan(CALL_TILE_WIDTH);
    expect(CALL_TILE_IS_PORTRAIT).toBe(true);
  });

  it("derives the CSS aspect-ratio from the same width/height", () => {
    expect(CALL_TILE_ASPECT).toBe(`${CALL_TILE_WIDTH} / ${CALL_TILE_HEIGHT}`);
    // A plain landscape-looking ratio (w/h > 1) would mean the web tile is
    // rendering wider than tall again.
    expect(CALL_TILE_WIDTH / CALL_TILE_HEIGHT).toBeLessThan(1);
  });
});
