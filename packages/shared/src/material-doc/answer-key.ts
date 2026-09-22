import type { MaterialBlock, MaterialDoc } from "./types";
import { ANSWER_KEY_CALLOUTS } from "./callouts";
import { parseMaterialDoc } from "./parse";
import { serializeMaterialDoc } from "./serialize";

// Answer-key visibility over a parsed MaterialDoc.
//
// WHY THIS EXISTS: the AI generation prompt deliberately puts every solution in
// a `> [!answer]` callout "so the answer key can be hidden during the lesson",
// and the on-screen renderers honour that by collapsing those callouts behind a
// "Show answer" toggle (COLLAPSIBLE_CALLOUTS in ./callouts.ts).
//
// THAT TOGGLE IS PRESENTATION, NOT A BOUNDARY. It keeps the answers from
// dominating the exercise flow; it does not keep them from a reader. A device
// that holds the body can open the toggle, read the body out of the page
// payload / API response / data packet, or print it. A rendered export makes
// the same point more bluntly: it has no toggle at all, so whatever the tree
// contains is on the page forever.
//
// So the cut is structural, and it is made wherever a document crosses into a
// STUDENT's hands: the PDF student copy (the original caller), the in-call
// materials the teacher opens on the student's screen, the student library and
// class views, and the podcast script prompt. `stripAnswerKey` is that cut over
// a parsed tree; `stripAnswerKeyMarkdown` below is the same cut for the callers
// that hold a stored Markdown body. The teacher's own reads keep the answers —
// she is the one person meant to see them.
//
// Pure and renderer-agnostic like the rest of this module: no I/O, no platform
// APIs, safe under Node, the browser, Hermes and react-pdf alike.

function stripBlocks(blocks: MaterialBlock[]): MaterialBlock[] {
  const kept: MaterialBlock[] = [];
  for (const block of blocks) {
    // Drop the whole callout, title included — a bare "Answer" header with no
    // body would advertise that something was removed.
    if (block.type === "callout" && ANSWER_KEY_CALLOUTS.has(block.variant)) continue;
    kept.push(stripBlock(block));
  }
  return kept;
}

// Answers nest: the generator commonly writes `> [!question]` with a
// `> > [!answer]` inside it, and a multi-part exercise hangs them off list
// items. Every container that can hold blocks has to recurse, or a nested
// answer survives the strip.
function stripBlock(block: MaterialBlock): MaterialBlock {
  switch (block.type) {
    case "callout":
      return { ...block, blocks: stripBlocks(block.blocks) };
    case "quote":
      return { ...block, blocks: stripBlocks(block.blocks) };
    case "list":
      return {
        ...block,
        items: block.items.map((item) => ({ ...item, children: stripBlocks(item.children) })),
      };
    default:
      return block;
  }
}

/** Whether the document carries any answer-key content, at any nesting depth.
 *
 * The clients use this to decide whether a "with answer key" download is worth
 * offering at all: on a material with no answers the two exports are
 * byte-identical, and a second button that silently does the same thing is
 * worse than no second button. */
export function hasAnswerKey(doc: MaterialDoc): boolean {
  const search = (blocks: MaterialBlock[]): boolean =>
    blocks.some((block) => {
      switch (block.type) {
        case "callout":
          return ANSWER_KEY_CALLOUTS.has(block.variant) || search(block.blocks);
        case "quote":
          return search(block.blocks);
        case "list":
          return block.items.some((item) => search(item.children));
        default:
          return false;
      }
    });
  return search(doc.blocks);
}

/** The student copy of a document: every answer-key callout removed, at any
 * nesting depth. Returns the input doc unchanged (same reference) when there
 * was nothing to strip; never mutates its input otherwise. */
export function stripAnswerKey(doc: MaterialDoc): MaterialDoc {
  if (!hasAnswerKey(doc)) return doc;
  return { blocks: stripBlocks(doc.blocks) };
}

/** The student copy of a stored Markdown `body`: parse, cut every answer-key
 * callout, serialize back.
 *
 * The Markdown-in / Markdown-out wrapper over `stripAnswerKey`, for the callers
 * that hold a body string rather than a parsed tree — the in-call material
 * resolver, the call's data-channel protocol and the student library view. They
 * all had the same three lines inlined, or (the bug this closes) none at all;
 * one function means a surface cannot ship the student a body the next surface
 * would have filtered.
 *
 * Returns the input string **by identity** when there is no answer key, so the
 * common case never pays for a parse/serialize round trip and a body that
 * happens to serialize slightly differently from how the teacher typed it (a
 * normalized list marker, say) is left byte-identical. `null`/empty in, the
 * same value out. */
export function stripAnswerKeyMarkdown(body: string): string;
export function stripAnswerKeyMarkdown(body: string | null): string | null;
export function stripAnswerKeyMarkdown(body: string | null): string | null {
  if (!body) return body;
  const doc = parseMaterialDoc(body);
  if (!hasAnswerKey(doc)) return body;
  return serializeMaterialDoc(stripAnswerKey(doc));
}
