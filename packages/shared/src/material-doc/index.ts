// The shared material document system — one semantic model + one parser + one
// serializer + one callout registry, consumed by every renderer (web, mobile,
// PDF) and by the structural section editor. See ./types.ts for the "why",
// ./parse.ts for the format decision and ./serialize.ts for the round-trip
// contract that lets a teacher edit the tree and store Markdown back.
export * from "./types";
export * from "./callouts";
export * from "./images";
// The tense-timeline block: its Markdown spelling, its normalization rules and
// the ONE geometry routine web / mobile / PDF each draw from, so the same
// document can't become three different diagrams. See ./timeline.ts's header
// for why a fenced code block is the spelling.
export * from "./timeline";
export {
  parseMaterialDoc,
  parseInline,
  parseBlockText,
  hasHomeworkCallout,
  extractHomeworkExcerptText,
} from "./parse";
export { hasAnswerKey, stripAnswerKey, stripAnswerKeyMarkdown } from "./answer-key";
export {
  serializeMaterialDoc,
  serializeBlocks,
  serializeBlock,
  serializeInline,
} from "./serialize";
export type { HeadingBlock, MaterialSection, SectionOptions } from "./sections";
export {
  splitSections,
  joinSections,
  deleteSection,
  duplicateSection,
  insertSection,
  renumberHeadings,
} from "./sections";
// `moveSection` is taken at the package root by ./dashboard-layout, which moves
// a section of the teacher's dashboard — an unrelated concept with existing
// callers. Only this one name clashes, so only this one is re-exported under a
// scoped alias; inside ./sections.ts it keeps its plain name.
export { moveSection as moveMaterialSection } from "./sections";
// The section editor's state core (web + mobile section editors, Layer 2/3 of
// the material-editing design) — promoted from
// apps/web/src/lib/materials/section-editor.ts so both clients import the
// identical reorder/delete/undo/AI-splice behaviour. `EditorSection` and
// `SectionEditorState` are plain data shapes, not clashing with anything else
// exported here.
export {
  adoptBody,
  applySectionAction,
  editorSections,
  emptySectionEditorState,
  hasSection,
  resolveSectionLevel,
  SECTION_UNDO_LIMIT,
  undoSectionAction,
} from "./editor";
export type { EditorSection, SectionAction, SectionActionKind, SectionEditorState } from "./editor";
// Per-block editing ops (web + mobile per-block editors, Phase 4 of
// the material-editing design) — a flat MaterialBlock[] array
// in, one out; recursion into a callout's own nested blocks is a property of
// how the UI composes this module (see block-editor.ts's own header), not of
// the module itself.
export type { ListBlock, TableBlock, CalloutBlock, ImageBlock } from "./block-editor";
export {
  replaceBlockAt,
  updateBlockAt,
  removeBlockAt,
  insertBlockAt,
  editBlockText,
  updateCalloutVariant,
  updateCalloutTitle,
  updateListItemText,
  toggleListItemChecked,
  insertListItem,
  removeListItem,
  moveListItem,
  updateTableCell,
  insertTableRow,
  removeTableRow,
  insertTableColumn,
  removeTableColumn,
  newParagraphBlock,
  newListBlock,
  newCalloutBlock,
  newTableBlock,
  newDividerBlock,
  newImageBlock,
  updateImageAlt,
  updateImageSrc,
  newTimelineBlock,
  updateTimelineLabel,
  insertTimelinePoint,
  updateTimelinePointLabel,
  updateTimelinePointAt,
  removeTimelinePoint,
  setTimelineSpan,
  updateTimelineSpanLabel,
  clearTimelineSpan,
  defaultTimelineSpan,
} from "./block-editor";
