// Field limits for a testimonial, in a module with NO prisma import.
//
// Split out of ./store for the same reason storage/testimonial-photos-public-url
// was split out of storage/testimonial-photos: the editor is a Client Component
// and wants the real caps to render its character counter and `maxLength`, but
// ./store reaches for `@/lib/prisma` and cannot be bundled for the browser. The
// alternative — the client repeating `maxLength={600}` next to a server schema
// that says 600 somewhere else — is how the two drift, and it already had: the
// counter would have been the third copy.
//
// ./store re-exports these, so every existing server-side import is unchanged.
//
// ⚠️ It did not. ./store declared its OWN `= 600` beside this one and never
// imported this file, so the drift this split exists to prevent had already
// happened — two independent literals, plus a third in the student form and
// three more baked into the locale catalogues. Raising the cap to 1200 in
// 2026-09 found all six. ./store now genuinely re-exports, the forms read
// these, and the messages interpolate `{max}` rather than spelling a number
// that has to be changed in six places to stay true.

export const TESTIMONIAL_AUTHOR_MAX = 80;
export const TESTIMONIAL_NOTE_MAX = 80;
export const TESTIMONIAL_BODY_MAX = 1200;
