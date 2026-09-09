// Pure geometry/timing for the call's DRAGGABLE video tiles (self-view and
// the material-mode remote picture-in-picture) — shared by the mobile
// NativeCall (PanResponder + Animated) and the web ClassCall (pointer
// events), so the bounds math and the auto-hide delay can't drift the way
// the tile SIZE once did (see call-tile.ts). Each platform owns its own
// gesture-runtime wiring; this owns "given a drag gesture, where does the
// tile end up" and "was that release a tap, not a drag" — both unit-testable
// without either platform's runtime.

import { CALL_TILE_WIDTH, CALL_TILE_HEIGHT } from "./call-tile";

export const SELFVIEW_W = CALL_TILE_WIDTH;
export const SELFVIEW_H = CALL_TILE_HEIGHT;
export const SELFVIEW_MARGIN = 16;

export type SelfViewPosition = { x: number; y: number };

export type SelfViewBounds = {
  screenW: number;
  screenH: number;
  // How much space at the bottom of the screen the tile must stay clear of.
  //
  // Named for what web passes — the height of its controls bar, so a tile is
  // never dragged behind it — but read by the functions below as nothing more
  // specific than "reserved bottom space", and the two mobile call sites
  // deliberately pass DIFFERENT values for it: the controls-bar height when
  // choosing a tile's STARTING corner (so it spawns above the bar), and the
  // bare safe-area inset when clamping a DRAG (so the user can park a tile
  // below the bar, out of the way of an open material — the bar is a small
  // centred pill there, and it collapses away entirely). See NativeCall.tsx's
  // `dragBottomBoundH`.
  controlsBlockH: number;
};

// Starting corner: bottom-right, above the controls bar.
export function initialSelfViewPosition(bounds: SelfViewBounds): SelfViewPosition {
  return {
    x: bounds.screenW - SELFVIEW_W - SELFVIEW_MARGIN,
    y: Math.max(
      SELFVIEW_MARGIN,
      bounds.screenH - SELFVIEW_H - bounds.controlsBlockH - SELFVIEW_MARGIN,
    ),
  };
}

// Remote-participant PiP's default corner: top-right, below `topOffset`
// (safe-area inset + clearance for the recording badge). Reuses the same
// clamp as a drag release so it can never start off-screen or behind the
// controls bar on a short/rotated screen either.
export function initialRemotePipPosition(
  bounds: SelfViewBounds,
  topOffset: number,
): SelfViewPosition {
  const x = bounds.screenW - SELFVIEW_W - SELFVIEW_MARGIN;
  return clampSelfViewPosition({ x, y: topOffset }, { dx: 0, dy: 0 }, bounds);
}

// Web's floating tiles anchor at the bottom in either corner (left for the
// material-mode remote PiP, right for the self-view) rather than mobile's
// bottom-right/top-right pair — this is the web-shaped equivalent of the two
// functions above, reusing the same clamp so it can't start off-screen either.
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
// every draggable/tappable element on both platforms (mobile's
// DraggableVideoTile + MinimizedCallBubble, web's draggable self-view/remote
// tiles + minimized bubble), so the same threshold can't quietly drift
// between call sites.
export const TAP_MOVE_THRESHOLD_PX = 6;
export const TAP_MAX_DURATION_MS = 400;

export function isTapGesture(delta: { dx: number; dy: number }, elapsedMs: number): boolean {
  const moved = Math.hypot(delta.dx, delta.dy) > TAP_MOVE_THRESHOLD_PX;
  return !moved && elapsedMs < TAP_MAX_DURATION_MS;
}

// How long the call's bottom controls stay visible after the last
// interaction before fading out (Zoom/Meet/FaceTime convention) — one
// constant so mobile and web can't disagree on the timing.
export const CALL_CONTROLS_HIDE_DELAY_MS = 4000;
