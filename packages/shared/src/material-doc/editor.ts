import { parseMaterialDoc } from "./parse";
import { joinSections, renumberHeadings, splitSections } from "./sections";
import type { HeadingBlock, MaterialSection } from "./sections";
import { serializeMaterialDoc } from "./serialize";
import type { InlineNode, MaterialDoc } from "./types";

// The state core of the section editor (Layer 2/3 of
// the material-editing design), shared by the web and mobile
// components so "what a structural edit does" has exactly one implementation.
// Everything here is pure Markdown-in / Markdown-out: the component owns no
// document logic, so the reorder / delete / undo / AI-splice behaviour is
// unit-testable in node without a DOM, and the shared section ops stay the
// only implementation of "what a section is".
//
// The body string remains the single source of truth (the host component owns
// it and posts it with the save form) — every action below parses it, drives a
// shared op, and serializes back. That means the FIRST structural edit
// normalizes the stored Markdown's style; the MaterialRevision snapshot taken
// on save is what makes that reversible, and the undo stack here is only for
// the current, unsaved editing session.
//
// TWO INVARIANTS the state carries beyond the body (both fixes to real bugs):
//
//  - `level` — the heading level cards are cut at — is resolved ONCE when a
//    body is adopted and then pinned. Re-deriving it per action made the cut
//    unstable: deleting one of two `##` parts dropped the `##` count below the
//    "has siblings" threshold and every remaining card collapsed into one.
//
//  - `ids` — one opaque id per card, aligned with `editorSections(state)` and
//    permuted in lockstep by every action. They give the components stable
//    React keys (so per-card UI state — an open refine box, a half-typed
//    instruction — stays with its SECTION when indices shift under it), and
//    they are how an in-flight AI refine names its target: relocating by
//    content broke the moment `renumberHeadings` rewrote the heading the
//    content was captured from, and the old index fallback then spliced the
//    result into whatever card had slid into that position.

/** How many structural edits back the in-session undo reaches. Deliberately
 * bounded: this is a convenience buffer, not a history feature — the revision
 * snapshot on save is the real backstop. */
export const SECTION_UNDO_LIMIT = 20;

export type SectionActionKind =
  "move" | "delete" | "duplicate" | "insert" | "refine" | "editBlocks";

export type SectionAction =
  /** Splice semantics, same as the shared op: remove `from`, insert at `to`. */
  | { kind: "move"; from: number; to: number }
  /** No-op on the only remaining section — deleting the last card would empty
   * the body, unmount the editor, and take the undo stack (the one recovery
   * path for an unsaved draft) with it. The UI disables the button too. */
  | { kind: "delete"; index: number }
  | { kind: "duplicate"; index: number }
  /** Insert an empty, titled section BEFORE `index` (`sections.length` appends). */
  | { kind: "insert"; index: number; title: string }
  /** Splice an AI-refined section back in. `id` names the target card — the
   * one identity that survives moves, renumbering and unrelated edits while
   * the model round trip is in flight. If the card was deleted meanwhile the
   * action is a NO-OP (same state reference back): the result must be
   * discarded, never spliced at a guessed position. Callers can check
   * `hasSection(state, id)` up front to tell the teacher why. */
  | { kind: "refine"; id: string; markdown: string }
  /** A direct (non-AI) per-block edit inside the card at `index` — the
   * per-block editor (Phase 4) reconstructs that section's whole Markdown
   * (heading + its own edited body blocks, via `packages/shared/src/
   * material-doc/block-editor.ts`) and hands it back here. Index-addressed:
   * it's synchronous (no AI round trip in flight), so `index` is always
   * current at dispatch time. */
  | { kind: "editBlocks"; index: number; markdown: string };

export type SectionEditorState = {
  body: string;
  /** The card cut level, pinned at adopt time — see the header comment. */
  level: 1 | 2 | 3;
  /** One opaque id per card, aligned with `editorSections(state)`. */
  ids: string[];
  /** Most recent first: `[0]` is what `undoSectionAction` restores. */
  history: { body: string; ids: string[]; kind: SectionActionKind }[];
};

/** One card in the editor. `markdown` is this section alone, serialized — what
 * a per-section AI refine sends as its whole "body". */
export type EditorSection = {
  /** Stable identity — use as the React key and as a refine target. */
  id: string;
  index: number;
  /** Plain-text heading, or null for the synthetic pre-heading lead section. */
  title: string | null;
  level: 1 | 2 | 3 | null;
  markdown: string;
};

// Opaque and session-local — ids never persist (the saved artifact is still
// just the body string), so a monotonic counter is all the uniqueness needed.
let idCounter = 0;
function freshId(): string {
  idCounter += 1;
  return `sec${idCounter}`;
}

function sectionsOf(body: string, level: 1 | 2 | 3): MaterialSection[] {
  return splitSections(parseMaterialDoc(body), { level });
}

export function emptySectionEditorState(body: string): SectionEditorState {
  const level = resolveSectionLevel(parseMaterialDoc(body));
  return {
    body,
    level,
    ids: sectionsOf(body, level).map(freshId),
    history: [],
  };
}

// --- section granularity ----------------------------------------------------

/** Pick the heading level to cut cards at.
 *
 * `splitSections` without a level nests, which makes the usual `# Title` +
 * `## Part` material a single section — one useless card. The plan's answer is
 * to pass `{ level: 2 }`, and that is the common case here; but a material that
 * numbers its parts with `###` (or with `#`) would collapse the same way, so
 * this picks the SHALLOWEST level that actually has siblings to separate, and
 * falls back to the shallowest level present.
 *
 * Called only when a body is ADOPTED (see the header comment) — the resolved
 * level is then pinned in the state so an edit that changes the heading census
 * cannot re-cut the cards mid-session. */
export function resolveSectionLevel(doc: MaterialDoc): 1 | 2 | 3 {
  const counts = new Map<1 | 2 | 3, number>();
  for (const block of doc.blocks) {
    if (block.type !== "heading") continue;
    counts.set(block.level, (counts.get(block.level) ?? 0) + 1);
  }
  const levels: (1 | 2 | 3)[] = [1, 2, 3];
  return (
    levels.find((level) => (counts.get(level) ?? 0) >= 2) ??
    levels.find((level) => (counts.get(level) ?? 0) >= 1) ??
    2
  );
}

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.value;
        case "strong":
        case "em":
        case "link":
          return inlineText(node.children);
      }
    })
    .join("");
}

function sectionMarkdown(section: MaterialSection): string {
  return serializeMaterialDoc(joinSections([section]));
}

/** The card list for a state, in document order. */
export function editorSections(state: SectionEditorState): EditorSection[] {
  return sectionsOf(state.body, state.level).map((section, index) => ({
    id: state.ids[index] ?? `sec-overflow-${index}`,
    index,
    title: section.heading ? inlineText(section.heading.inlines).trim() || null : null,
    level: section.heading?.level ?? null,
    markdown: sectionMarkdown(section),
  }));
}

/** Is the card an in-flight async operation targeted still present? */
export function hasSection(state: SectionEditorState, id: string): boolean {
  return state.ids.includes(id);
}

// --- actions ----------------------------------------------------------------

function newSection(title: string, level: 1 | 2 | 3): MaterialSection {
  const heading: HeadingBlock = {
    type: "heading",
    level,
    inlines: [{ type: "text", value: title }],
  };
  return { heading, blocks: [] };
}

/** Plain-data deep copy — same rationale as sections.ts's `cloneSection`
 * (the tree is JSON by construction; `structuredClone` isn't guaranteed on
 * Hermes). */
function cloneSection(section: MaterialSection): MaterialSection {
  return JSON.parse(JSON.stringify(section)) as MaterialSection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The sections and ids arrays after an action, permuted in lockstep — or null
 * for a no-op (out of range, guarded, or target gone). */
function nextSections(
  state: SectionEditorState,
  action: SectionAction,
): { sections: MaterialSection[]; ids: string[] } | null {
  const sections = sectionsOf(state.body, state.level);
  const ids = [...state.ids];

  switch (action.kind) {
    case "move": {
      if (action.from < 0 || action.from >= sections.length) return null;
      const target = clamp(action.to, 0, sections.length - 1);
      if (target === action.from) return null;
      const [movedSection] = sections.splice(action.from, 1);
      sections.splice(target, 0, movedSection);
      const [movedId] = ids.splice(action.from, 1);
      ids.splice(target, 0, movedId);
      return { sections, ids };
    }
    case "delete": {
      if (action.index < 0 || action.index >= sections.length) return null;
      if (sections.length <= 1) return null; // never delete the last card
      sections.splice(action.index, 1);
      ids.splice(action.index, 1);
      return { sections, ids };
    }
    case "duplicate": {
      if (action.index < 0 || action.index >= sections.length) return null;
      sections.splice(action.index + 1, 0, cloneSection(sections[action.index]));
      ids.splice(action.index + 1, 0, freshId());
      return { sections, ids };
    }
    case "insert": {
      const at = clamp(action.index, 0, sections.length);
      sections.splice(at, 0, newSection(action.title, state.level));
      ids.splice(at, 0, freshId());
      return { sections, ids };
    }
    case "refine": {
      const index = ids.indexOf(action.id);
      if (index === -1) return null; // target deleted while in flight — discard
      return spliceMarkdown(state, sections, ids, index, action.markdown);
    }
    case "editBlocks": {
      if (action.index < 0 || action.index >= sections.length) return null;
      return spliceMarkdown(state, sections, ids, action.index, action.markdown);
    }
  }
}

/** Replace one section with everything a Markdown fragment parses to. The
 * fragment is split at the SAME level as the host document, so a model that
 * answered with several parts becomes several cards instead of one blob. The
 * replaced card keeps its id on the first resulting section (focus and any
 * in-flight UI state stay put); extra sections get fresh ids. */
function spliceMarkdown(
  state: SectionEditorState,
  sections: MaterialSection[],
  ids: string[],
  index: number,
  markdown: string,
): { sections: MaterialSection[]; ids: string[] } | null {
  const replacement = splitSections(parseMaterialDoc(markdown), { level: state.level });
  // Emptying the ONLY card would empty the body — same guard as `delete`.
  if (!replacement.length && sections.length <= 1) return null;
  sections.splice(index, 1, ...replacement);
  ids.splice(index, 1, ...replacement.map((_, i) => (i === 0 ? ids[index] : freshId())));
  return { sections, ids };
}

/** Apply a structural action, pushing the pre-edit body onto the undo stack.
 * A no-op action (an out-of-range index, a guarded delete, a refine whose
 * target card is gone, a move that changes nothing) returns the state
 * unchanged — same reference — so undo never rewinds past an edit the teacher
 * never saw happen, and callers can detect the drop. */
export function applySectionAction(
  state: SectionEditorState,
  action: SectionAction,
): SectionEditorState {
  const next = nextSections(state, action);
  if (!next) return state;

  const body = serializeMaterialDoc(renumberHeadings(joinSections(next.sections)));
  if (body === state.body) return state;

  // Reconcile: the serialize→reparse round trip can MERGE sections (a headless
  // fragment spliced after another section folds into it), so the id
  // arithmetic above can overcount. Identity can't be tracked through a merge;
  // regenerate rather than misalign.
  let ids = next.ids;
  const count = sectionsOf(body, state.level).length;
  if (ids.length !== count) ids = sectionsOf(body, state.level).map(freshId);

  return {
    body,
    level: state.level,
    ids,
    history: [{ body: state.body, ids: state.ids, kind: action.kind }, ...state.history].slice(
      0,
      SECTION_UNDO_LIMIT,
    ),
  };
}

/** Step one structural edit back. Returns the state unchanged when there is
 * nothing to undo. */
export function undoSectionAction(state: SectionEditorState): SectionEditorState {
  const [last, ...rest] = state.history;
  if (!last) return state;
  return { body: last.body, level: state.level, ids: last.ids, history: rest };
}

/** Adopt a body the editor did not produce (a whole-document refine, a restored
 * revision, a template). The undo stack is dropped: its entries describe a
 * different document, and offering to "undo" back into one would silently
 * discard the teacher's newer content. The cut level is re-resolved and the
 * card identities are fresh — it is a different document. */
export function adoptBody(state: SectionEditorState, body: string): SectionEditorState {
  if (body === state.body) return state;
  return emptySectionEditorState(body);
}
