import type { InlineNode, MaterialBlock, MaterialDoc } from "./types";

// Section-level structural operations over a MaterialDoc — the pure core the
// web and mobile section editors both drive (Layer 1 of
// the material-editing design). No UI, no I/O, no dependencies:
// same Node/browser/Hermes/react-pdf guarantee the parser and serializer make.
//
// The block tree is deliberately FLAT — headings are blocks, not containers, so
// a truncated stream always yields a valid doc (see types.ts). "Sections" are
// therefore a *view* computed on demand rather than a stored shape: split, edit
// the array, join back. Every operation below returns a NEW doc and never
// mutates its input, so a caller can keep the previous tree for undo.

export type HeadingBlock = Extract<MaterialBlock, { type: "heading" }>;

/** A heading and everything it owns. A section runs from its heading up to the
 * next heading of the SAME OR HIGHER level, so a deeper subheading and its body
 * stay inside the parent section — moving "## 2. Practice" carries its "###"
 * subsections with it, which is what a teacher means by "move this part".
 *
 * `heading: null` marks the synthetic leading section holding any blocks before
 * the document's first heading (a title-less intro paragraph, a divider). It
 * exists so `splitSections`/`joinSections` never lose content; there is at most
 * one, always at index 0. */
export type MaterialSection = {
  heading: HeadingBlock | null;
  blocks: MaterialBlock[];
};

/** The granularity to cut a document at, for every function in this module.
 *
 * Omitted, sections nest: each one ends at the next heading of its own level or
 * shallower. That is the natural reading of the document's outline, but a
 * generated material usually hangs everything under one `#` title, which makes
 * the whole body a single section — useless as a set of editor cards. Passing a
 * level cuts at every heading that senior or more, so `{ level: 2 }` on a
 * `# Title` / `## Part` material yields the title plus one section per part.
 *
 * Pass the SAME level to every call in one editing session: the indices
 * `moveSection`/`deleteSection`/… take are indices into the section list a
 * matching `splitSections` produced. */
export type SectionOptions = { level?: 1 | 2 | 3 };

/** Group a document's flat block list into sections, in document order. */
export function splitSections(doc: MaterialDoc, options: SectionOptions = {}): MaterialSection[] {
  const sections: MaterialSection[] = [];
  let current: MaterialSection | null = null;
  let openLevel = 0;

  for (const block of doc.blocks) {
    const opensSection =
      block.type === "heading" &&
      (current === null || current.heading === null || block.level <= (options.level ?? openLevel));

    if (opensSection) {
      if (current) sections.push(current);
      current = { heading: block as HeadingBlock, blocks: [] };
      openLevel = (block as HeadingBlock).level;
      continue;
    }

    if (!current) current = { heading: null, blocks: [] };
    current.blocks.push(block);
  }

  if (current) sections.push(current);
  return sections;
}

/** Flatten sections back into a document. The exact inverse of
 * `splitSections` — `joinSections(splitSections(doc))` deep-equals `doc`. */
export function joinSections(sections: MaterialSection[]): MaterialDoc {
  const blocks: MaterialBlock[] = [];
  for (const section of sections) {
    if (section.heading) blocks.push(section.heading);
    blocks.push(...section.blocks);
  }
  return { blocks };
}

// --- heading renumbering ----------------------------------------------------

// A teacher's material commonly numbers its parts in the heading text itself
// ("## 1. Warm-up", "## 2. Practice"). Delete part 2 and the rest are wrong —
// exactly the edit an AI refine round-trip fumbles. Ordered *lists* need
// nothing: their numbering is derived at render time from item position.
const NUMBER_PREFIX = /^(\d+)([.)])(\s+)/;

function numberedPrefix(block: MaterialBlock): RegExpExecArray | null {
  if (block.type !== "heading") return null;
  const first = block.inlines[0];
  if (!first || first.type !== "text") return null;
  return NUMBER_PREFIX.exec(first.value);
}

function withNumber(heading: HeadingBlock, ordinal: number): HeadingBlock {
  const match = numberedPrefix(heading);
  const first = heading.inlines[0];
  if (!match || !first || first.type !== "text") return heading;
  if (match[1] === String(ordinal)) return heading;
  // Keep the author's own separator and spacing (`1.` vs `1)`), rewrite only
  // the digits.
  const value = `${ordinal}${match[2]}${match[3]}${first.value.slice(match[0].length)}`;
  const inlines: InlineNode[] = [{ type: "text", value }, ...heading.inlines.slice(1)];
  return { ...heading, inlines };
}

/** Rewrite numeric heading prefixes so each set of numbered siblings reads
 * 1, 2, 3… in document order.
 *
 * Siblings are headings at the same level with no lower-level (more senior)
 * heading between them, so `# Part A / ## 1. x / ## 2. y / # Part B / ## 1. p`
 * restarts under Part B instead of counting to 3. A level is treated as a
 * numbered set only when at least TWO of its siblings carry a prefix — one
 * heading that happens to start with "2024. " is prose, not an index. Unnumbered
 * siblings are left untouched and do not consume an ordinal.
 *
 * Returns the input doc unchanged (same reference) when nothing needs
 * rewriting. */
export function renumberHeadings(doc: MaterialDoc): MaterialDoc {
  const ordinals = new Map<number, number>(); // block index -> new ordinal
  const openGroups = new Map<number, number[]>(); // heading level -> block indices

  const flush = (indices: number[]) => {
    const numbered = indices.filter((i) => numberedPrefix(doc.blocks[i]) !== null);
    if (numbered.length < 2) return;
    numbered.forEach((blockIndex, n) => ordinals.set(blockIndex, n + 1));
  };

  doc.blocks.forEach((block, index) => {
    if (block.type !== "heading") return;
    // A more senior heading closes every deeper group beneath it.
    for (const [level, indices] of openGroups) {
      if (level > block.level) {
        flush(indices);
        openGroups.delete(level);
      }
    }
    const group = openGroups.get(block.level);
    if (group) group.push(index);
    else openGroups.set(block.level, [index]);
  });
  for (const indices of openGroups.values()) flush(indices);

  if (!ordinals.size) return doc;

  let changed = false;
  const blocks = doc.blocks.map((block, index) => {
    const ordinal = ordinals.get(index);
    if (ordinal === undefined || block.type !== "heading") return block;
    const next = withNumber(block, ordinal);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { blocks } : doc;
}

// --- structural operations --------------------------------------------------

/** Plain-data deep copy. The tree is JSON by construction (types.ts), and this
 * avoids depending on `structuredClone`, which is not guaranteed on Hermes. */
function cloneSection(section: MaterialSection): MaterialSection {
  return JSON.parse(JSON.stringify(section)) as MaterialSection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rebuild(sections: MaterialSection[]): MaterialDoc {
  return renumberHeadings(joinSections(sections));
}

/** Move the section at `from` to index `to` (splice semantics: the section is
 * removed, then inserted at `to` in the shortened array). `to` is clamped into
 * range; an out-of-range `from`, or a no-op move, returns the input doc
 * unchanged. */
export function moveSection(
  doc: MaterialDoc,
  from: number,
  to: number,
  options: SectionOptions = {},
): MaterialDoc {
  const sections = splitSections(doc, options);
  if (from < 0 || from >= sections.length) return doc;
  const target = clamp(to, 0, sections.length - 1);
  if (target === from) return doc;
  const [moved] = sections.splice(from, 1);
  sections.splice(target, 0, moved);
  return rebuild(sections);
}

/** Remove a section — its heading and everything it owns, subheadings
 * included. An out-of-range index returns the input doc unchanged. */
export function deleteSection(
  doc: MaterialDoc,
  index: number,
  options: SectionOptions = {},
): MaterialDoc {
  const sections = splitSections(doc, options);
  if (index < 0 || index >= sections.length) return doc;
  sections.splice(index, 1);
  return rebuild(sections);
}

/** Insert a deep copy of a section directly after the one at `index`. An
 * out-of-range index returns the input doc unchanged. */
export function duplicateSection(
  doc: MaterialDoc,
  index: number,
  options: SectionOptions = {},
): MaterialDoc {
  const sections = splitSections(doc, options);
  if (index < 0 || index >= sections.length) return doc;
  sections.splice(index + 1, 0, cloneSection(sections[index]));
  return rebuild(sections);
}

/** Insert a section before position `index` (clamped to the ends, so
 * `sections.length` appends). The section is deep-copied, so the caller may
 * keep and reuse the template it passed in.
 *
 * A headless section (`heading: null`) inserted anywhere but the front is legal
 * but not round-trippable: with no heading of its own, a later `splitSections`
 * folds its blocks into the preceding section. */
export function insertSection(
  doc: MaterialDoc,
  index: number,
  section: MaterialSection,
  options: SectionOptions = {},
): MaterialDoc {
  const sections = splitSections(doc, options);
  sections.splice(clamp(index, 0, sections.length), 0, cloneSection(section));
  return rebuild(sections);
}
