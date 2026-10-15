// Pure geometry/timing for the call's DRAGGABLE video tiles (self-view and
// the material-mode remote picture-in-picture), used by ClassCall's pointer
// events. The component owns the gesture wiring; this owns "given a drag
// gesture, where does the tile end up" and "was that release a tap, not a
// drag" — both unit-testable without the browser runtime.

import { CALL_TILE_WIDTH, CALL_TILE_HEIGHT } from "./call-tile";

export const SELFVIEW_W = CALL_TILE_WIDTH;
export const SELFVIEW_H = CALL_TILE_HEIGHT;
export const SELFVIEW_MARGIN = 16;

export type SelfViewPosition = { x: number; y: number };

export type SelfViewBounds = {
  screenW: number;
  screenH: number;
  // How much space at the bottom of the screen the tile must stay clear of:
  // the height of the controls bar, so a tile is never dragged behind it. The
  // functions below read it as nothing more specific than "reserved bottom
  // space".
  controlsBlockH: number;
};

// The floating tiles anchor at the bottom in either corner (left for the
// material-mode remote PiP, right for the self-view), reusing the drag clamp
// so a tile can't start off-screen.
export function initialFloatingTilePosition(
  bounds: SelfViewBounds,
  corner: "left" | "right",
): SelfViewPosition {
  const x = corner === "right" ? bounds.screenW - SELFVIEW_W - SELFVIEW_MARGIN : SELFVIEW_MARGIN;
  const y = Math.max(
    SELFVIEW_MARGIN,
    bounds.screenH - SELFVIEW_H - bounds.controlsBlockH - SELFVIEW_MARGIN,
  );
  return clampSelfViewPosition({ x, y }, { dx: 0, dy: 0 }, bounds);
}

// Clamp a resting position + gesture delta to stay fully on screen and above
// the controls bar — the one function a drag move/release handler needs to
// call, on either platform.
export function clampSelfViewPosition(
  base: SelfViewPosition,
  delta: { dx: number; dy: number },
  bounds: SelfViewBounds,
): SelfViewPosition {
  const x = Math.max(
    SELFVIEW_MARGIN,
    Math.min(bounds.screenW - SELFVIEW_W - SELFVIEW_MARGIN, base.x + delta.dx),
  );
  const y = Math.max(
    SELFVIEW_MARGIN,
    Math.min(
      bounds.screenH - SELFVIEW_H - bounds.controlsBlockH - SELFVIEW_MARGIN,
      base.y + delta.dy,
    ),
  );
  return { x, y };
}

// Pure "was this gesture release a tap, not a drag" classifier — shared by
// every draggable/tappable element in the call (the self-view/remote tiles and
// the minimized bubble), so the same threshold can't quietly drift between
// call sites.
export const TAP_MOVE_THRESHOLD_PX = 6;
export const TAP_MAX_DURATION_MS = 400;

export function isTapGesture(delta: { dx: number; dy: number }, elapsedMs: number): boolean {
  const moved = Math.hypot(delta.dx, delta.dy) > TAP_MOVE_THRESHOLD_PX;
  return !moved && elapsedMs < TAP_MAX_DURATION_MS;
}

// How long the call's bottom controls stay visible after the last
// interaction before fading out (Zoom/Meet/FaceTime convention).
export const CALL_CONTROLS_HIDE_DELAY_MS = 4000;
