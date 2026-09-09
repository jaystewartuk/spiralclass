import type { CallMaterial } from "./api";
import { stripAnswerKeyMarkdown } from "./material-doc/index";

// The ONE definition of "the copy of an in-call material a student may hold".
//
// WHY THIS EXISTS. A material's `body` is the teacher's authoring copy: the AI
// generation prompt deliberately puts every solution in a `> [!answer]` callout
// so it can be held back, and the on-screen renderers collapse those behind a
// "Show answer" toggle. That toggle is TYPOGRAPHY, NOT A BOUNDARY — a student
// whose device holds the body can tap it open, read it out of the RSC payload
// or the /api/mobile JSON, or pull it off the LiveKit data channel. The only
// way answers are actually withheld is for the answer bytes never to reach the
// student's device at all, which is exactly the cut the PDF export already
// makes for the student copy (see material-doc/answer-key.ts).
//
// Every student-facing producer of a CallMaterial routes through here rather
// than stripping for itself, so a new surface can only be wrong by not calling
// it — never by calling it slightly differently from the surface next door.
//
// Cheap and idempotent: with no answer key it returns the SAME object
// reference, so re-applying it at a second boundary (the wire decoder does
// exactly that) costs one parse and allocates nothing.

/** The student copy of one in-call material: identical except that every
 * answer-key callout is cut out of `body`, at any nesting depth. A file/link
 * material (`body: null`) comes back untouched. */
export function studentCallMaterial(material: CallMaterial): CallMaterial {
  const body = stripAnswerKeyMarkdown(material.body);
  return body === material.body ? material : { ...material, body };
}
