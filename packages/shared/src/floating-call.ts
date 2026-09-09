// Pure geometry for the minimized/floating call window (WhatsApp-style
// "collapse the call to a small draggable bubble") — shared by the web
// ClassCall and the mobile NativeCall so corner-snap math can't drift the way
// the self-view tile size once did (see call-tile.ts). The component owns the
// drag gesture wiring (PanResponder on mobile, pointer events on web); this
// owns "given where a drag released, which corner does the bubble snap to and
// where does that corner sit" — unit-testable without either platform's
// runtime.

export type FloatingCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type FloatingPosition = { x: number; y: number };

export type FloatingBounds = {
  // The container the bubble drags within (viewport on web, screen on mobile).
  width: number;
  height: number;
  // The bubble's own size.
  tileWidth: number;
  tileHeight: number;
  // Minimum gap kept between the bubble and any edge.
  margin: number;
  // Extra clearance at the top (status bar / recording badge) and bottom
  // (the call's own controls bar, when the bubble floats over it) beyond
  // `margin`, so a snapped bubble never lands under either.
  topInset?: number;
  bottomInset?: number;
};

// Where a given corner's bubble sits, honoring the bounds' insets.
export function floatingCornerPosition(
  corner: FloatingCorner,
  bounds: FloatingBounds,
): FloatingPosition {
  const top = bounds.margin + (bounds.topInset ?? 0);
  const bottom = Math.max(
    top,
    bounds.height - bounds.tileHeight - bounds.margin - (bounds.bottomInset ?? 0),
  );
  const left = bounds.margin;
  const right = Math.max(left, bounds.width - bounds.tileWidth - bounds.margin);
  switch (corner) {
    case "top-left":
      return { x: left, y: top };
    case "top-right":
      return { x: right, y: top };
    case "bottom-left":
      return { x: left, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
  }
}

// Which corner a resting position is closest to, by which quadrant its
// center falls in — not distance-to-corner, so a bubble dragged to dead
// center still resolves to a single deterministic quadrant rather than
// being sensitive to the container's aspect ratio.
export function nearestFloatingCorner(
  position: FloatingPosition,
  bounds: FloatingBounds,
): FloatingCorner {
  const centerX = position.x + bounds.tileWidth / 2;
  const centerY = position.y + bounds.tileHeight / 2;
  const isRight = centerX > bounds.width / 2;
  const isBottom = centerY > bounds.height / 2;
  if (isBottom) return isRight ? "bottom-right" : "bottom-left";
  return isRight ? "top-right" : "top-left";
}

// Snap a drag-release position to its nearest corner, clamped to the bounds'
// insets. This is the one function a drag release handler needs to call.
export function snapToNearestCorner(
  position: FloatingPosition,
  bounds: FloatingBounds,
): FloatingPosition & { corner: FloatingCorner } {
  const corner = nearestFloatingCorner(position, bounds);
  return { ...floatingCornerPosition(corner, bounds), corner };
}

// The minimized call bubble's size. Deliberately its own constant rather than
// reusing CALL_TILE_WIDTH/HEIGHT (the self-view/remote-PiP tile) — the two
// happen to be close today, but one represents "a small preview inside a
// full-screen call" and the other "the entire call, collapsed," and they are
// free to diverge (e.g. the bubble growing controls of its own) without
// dragging the in-call tile size along with it.
export const FLOATING_CALL_WIDTH = 120;
export const FLOATING_CALL_HEIGHT = 160;
export const FLOATING_CALL_MARGIN = 12;
