// Canonical geometry for the call's small floating video tiles — the self-view
// and the material-mode remote picture-in-picture — rendered by ClassCall as a
// PORTRAIT tile of one aspect ratio.
//
// The drag-clamp math needs the concrete width/height in raw px; the call sets
// the width and derives its CSS `aspect-ratio` from the same two numbers via
// CALL_TILE_ASPECT. One source for both.

export const CALL_TILE_WIDTH = 110;
export const CALL_TILE_HEIGHT = 150;

// The CSS `aspect-ratio` value (`"110 / 150"`) for the tiles, so their
// proportions are derived from the very same numbers the drag clamp uses in px
// rather than a hand-copied ratio that can silently fall out of step.
export const CALL_TILE_ASPECT = `${CALL_TILE_WIDTH} / ${CALL_TILE_HEIGHT}`;

// Portrait is the whole point of sharing this — assert it here so a future edit
// that accidentally flips width/height trips the unit test rather than shipping
// a landscape self-view again.
export const CALL_TILE_IS_PORTRAIT = CALL_TILE_HEIGHT > CALL_TILE_WIDTH;
