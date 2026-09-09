// Canonical geometry for the call's small floating video tiles — the self-view
// and the material-mode remote picture-in-picture — shared by the web ClassCall
// and the mobile NativeCall so the two platforms can't drift.
//
// Both platforms render these as a PORTRAIT tile of the SAME aspect ratio, so a
// teacher on mobile and a student on web see a matching self-view. The web
// self-view was landscape (`h-32 w-44`, 176×128) against mobile's portrait
// (110×150) for exactly as long as the two owned separate copies of this
// number — that inconsistency is what this module exists to prevent.
//
// The drag-clamp math needs the concrete width/height in raw px; web sets the
// width and derives its CSS `aspect-ratio` from the same two numbers via
// CALL_TILE_ASPECT. One source for both.

export const CALL_TILE_WIDTH = 110;
export const CALL_TILE_HEIGHT = 150;

// The CSS `aspect-ratio` value (`"110 / 150"`) for the web tiles, so the web
// tile's proportions are derived from the very same numbers mobile lays out in
// px rather than a hand-copied ratio that can silently fall out of step.
export const CALL_TILE_ASPECT = `${CALL_TILE_WIDTH} / ${CALL_TILE_HEIGHT}`;

// Portrait is the whole point of sharing this — assert it here so a future edit
// that accidentally flips width/height trips the unit test rather than shipping
// a landscape self-view again.
export const CALL_TILE_IS_PORTRAIT = CALL_TILE_HEIGHT > CALL_TILE_WIDTH;
