// Pure geometry for the call stage's two video tiles (remote + local) —
// split out of class-call.tsx so it's unit-testable without the browser/
// LiveKit runtime the component itself needs (media is browser-only, see
// class-call.tsx's own note on why it has no component-level test). This
// owns "given which role a tile is playing right now, what CSS positions
// it" — the component owns deciding the role (from resolveCallStage +
// swapped/minimized) and attaching the actual track.
import type { CSSProperties } from "react";
import { CALL_TILE_HEIGHT, CALL_TILE_WIDTH, type SelfViewPosition } from "@spiralclass/shared";

// Web's floating tiles anchor at the bottom in either corner (left for the
// material-mode remote PiP, right for the self-view) — the starting
// position before the user ever drags one. Shared with mobile's
// initialSelfViewPosition/initialRemotePipPosition (which anchor
// bottom-right/top-right instead, since mobile's two floating tiles play
// different roles rather than sharing one corner-by-mode convention).
export { initialFloatingTilePosition } from "@spiralclass/shared";
export type { SelfViewBounds, SelfViewPosition } from "@spiralclass/shared";

export type StageTileRole = "big" | "floating-left" | "floating-right" | "hidden";

// The tap-to-swap animation only ever moves a tile between "big" (fills the
// stage) and "floating-right" (the self-view's usual corner) — the ONLY pair
// that shares an anchor edge (right + bottom) on every property, so a plain
// CSS transition on right/bottom/width/height interpolates cleanly with no
// intermediate `auto` value to snap through. "floating-left" (the
// material-mode remote PiP, anchored from the opposite edge) was never
// animated before this change and stays that way — swapping its anchor to
// `right` would need the container's live width to compute an equivalent
// `right` offset, which is more machinery than the one interaction this
// change actually asks for.
const SWAP_TRANSITION = "right 300ms ease, bottom 300ms ease, width 300ms ease, height 300ms ease";

export function computeStageTileStyle(
  role: StageTileRole,
  drag?: { position: SelfViewPosition | null; dragging?: boolean },
): CSSProperties {
  // A floating tile the user has actually dragged gets an absolute left/top
  // position instead of its default corner anchor — free-drag (item 1 of the
  // web/mobile call-UX parity work), clamped by the caller via
  // clampSelfViewPosition so it can never end up off-screen. No transition
  // while the pointer is still moving it (1:1 tracking, matching the
  // minimized bubble's own drag behavior); a short one on release so letting
  // go doesn't feel like it stops mid-motion.
  if ((role === "floating-left" || role === "floating-right") && drag?.position) {
    return {
      position: "absolute",
      left: drag.position.x,
      top: drag.position.y,
      width: CALL_TILE_WIDTH,
      height: CALL_TILE_HEIGHT,
      zIndex: 20,
      touchAction: "none",
      transition: drag.dragging ? undefined : "left 120ms ease, top 120ms ease",
    };
  }
  switch (role) {
    case "big":
      return {
        position: "absolute",
        right: 0,
        bottom: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        transition: SWAP_TRANSITION,
      };
    case "floating-right":
      return {
        position: "absolute",
        right: 16,
        bottom: 16,
        width: CALL_TILE_WIDTH,
        height: CALL_TILE_HEIGHT,
        zIndex: 20,
        touchAction: "none",
        transition: SWAP_TRANSITION,
      };
    case "floating-left":
      return {
        position: "absolute",
        left: 16,
        bottom: 16,
        width: CALL_TILE_WIDTH,
        height: CALL_TILE_HEIGHT,
        zIndex: 20,
        touchAction: "none",
      };
    case "hidden":
      return { position: "absolute", width: 0, height: 0, overflow: "hidden" };
  }
}

// Whether a role is one of the two floating corner tiles. Named because
// three call sites now branch on it (drag eligibility, resetting a remembered
// drag position, and the caption band's bottom clearance) and the
// `role === "floating-left" || role === "floating-right"` pair spelled out at
// each one is where a fourth variant would eventually get missed.
export function isFloatingRole(role: StageTileRole): boolean {
  return role === "floating-left" || role === "floating-right";
}

// Which role a tile plays: "big" if it's the stage's primary content, else a
// floating corner tile if it should show at all, else hidden (nothing to show
// — camera off, or minimized mode suppressing every tile but the primary).
export function resolveTileRole(input: {
  isBig: boolean;
  isFloating: boolean;
  corner: "left" | "right";
}): StageTileRole {
  if (input.isBig) return "big";
  if (!input.isFloating) return "hidden";
  return input.corner === "left" ? "floating-left" : "floating-right";
}
