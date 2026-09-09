import { sanitizeImageAlt, sanitizeImageSrc } from "./images";
import { parseInline, parseMaterialDoc } from "./parse";
import { serializeTimeline, TIMELINE_LANG } from "./timeline";
import type { ColumnAlign, InlineNode, ListItem, MaterialBlock, MaterialDoc } from "./types";

// The inverse of `parseMaterialDoc` — turns a MaterialDoc back into the same
// constrained GFM-Markdown dialect the parser reads (`> [!variant] title`
// callouts included).
//
// WHY IT EXISTS: Markdown stays the wire/storage format (see parse.ts for the
// full rationale — streaming, zero migration, LLM robustness), so a structural
// editor over the block tree needs a way back to the stored artifact. Without
// this, the only ways to change a body are a whole-document AI refine or a full
// regenerate; with it, "delete section 3" / "swap two sections" / "fix one
// word" become pure tree edits that serialize back to a body every downstream
// consumer (renderers, PDF, homework auto-draft, refine prompt) still
// understands. See the material-editing design.
//
// THE CONTRACT is a round trip through the parser, not byte equality with the
// original source:
//
//     parseMaterialDoc(serializeMaterialDoc(parseMaterialDoc(body)))
//       deep-equals parseMaterialDoc(body)
//
// Serializing a parsed tree therefore also *normalizes* the Markdown (`#`
// headings, `-` bullets, `**strong**`, one blank line between blocks). That is
// fine for machine-generated bodies, and every save snapshots a
// MaterialRevision first, so the first normalizing save is reversible.
//
// Dependency-free on purpose, exactly like the parser: it must run
// byte-identically under Node (web SSR + tests), the browser, Hermes (React
// Native) and the react-pdf pipeline, or the four surfaces stop agreeing. It
// imports the parser — the one module it is defined against — and nothing else.
//
// THE HARD PART is that the dialect has no GENERAL backslash escape: inline
// text carries `\*` through as two literal characters, so escaping is not
// available to disambiguate emphasis. Three narrow mechanisms stand in for it,
// each checked against the real parser rather than against a private copy of
// its rules, so none of them can drift when parse.ts changes:
//
//  - Emphasis picks the delimiter (`*`/`_`, `**`/`__`) that cannot re-associate
//    with the content it wraps or with the loose delimiters around it, and the
//    finished run is re-parsed to confirm it.
//  - A code fence picks a marker (```` ``` ````/`~~~`) that does not appear as a
//    fence line inside the block.
//  - A paragraph whose one-line form would open a different block (`* ]`,
//    `### x`) is reshaped using the two transforms the parser itself undoes —
//    the leading space it trims, and the soft wrap it rejoins with a space.
//
// Text nodes are otherwise emitted verbatim, because the parser only ever
// produces them from runs it *failed* to match as markup. The per-block editors
// (Phase 4) broke that assumption for a handful of POSITIONS — teacher-typed
// text can be a task-marker lookalike at an item head, a divider lookalike as a
// whole line, or contain `|` inside a table cell — and no reshape can express
// those. For exactly those positions the parser now honors a minimal leading
// backslash / GFM `\|` escape (see parse.ts, "the minimal escape"), and this
// serializer emits it, still oracle-verified against the real parser.
//
// KNOWN LIMIT: adversarial input can still defeat this — an em run nested
// *directly* inside another em run with no text between them (which the parser
// only ever produces from delimiter soup like `*___*`) has no unambiguous
// two-delimiter spelling. Random-punctuation fuzzing puts the residual around
// 0.2%, and none of it is reachable from prose; every realistic body, including
// every prefix of a streamed one, round-trips. If a case is ever found in real
// content, the fix is a third emphasis spelling, not an escape.

// --- inline -----------------------------------------------------------------

/** The character an already-serialized sibling contributes at the boundary, so
 * emphasis never picks a delimiter that would pair with it. A neighbouring
 * emphasis node imposes no constraint: `*a**b*` re-parses as two em runs
 * because the parser's inner match is lazy. */
function leadingChar(node: InlineNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "text":
      return node.value.slice(0, 1);
    case "code":
      return "`";
    case "link":
      return "[";
    default:
      return "";
  }
}

/** Wrap `inner` in the first delimiter that cannot merge with its own content
 * or with the loose delimiter characters around it, falling back to the
 * preferred one. `**a*b**` is safe (the inner `*` is unpaired); `**a***` is
 * not, because the trailing `*` pairs with the closing delimiter, and neither
 * is `**b*` anywhere after an unmatched `*` in the same run. */
function wrapEmphasis(
  inner: string,
  delims: readonly [string, string],
  before: string,
  after: string,
): string {
  // An empty run is unreachable from the parser (`**` requires ≥1 inner char)
  // and `****` would re-parse as emphasis-of-`*`, so drop the markers.
  if (!inner) return inner;
  for (const delim of delims) {
    const char = delim[0];
    if (
      !inner.includes(delim) &&
      !inner.startsWith(char) &&
      !inner.endsWith(char) &&
      !before.includes(char) &&
      after !== char
    ) {
      return delim + inner + delim;
    }
  }
  return delims[0] + inner + delims[0];
}

const STRONG_DELIMS = ["**", "__"] as const;
const STRONG_DELIMS_ALT = ["__", "**"] as const;
const EM_DELIMS = ["*", "_"] as const;
const EM_DELIMS_ALT = ["_", "*"] as const;

function renderInline(nodes: InlineNode[], underscoreFirst: boolean): string {
  let out = "";
  // Delimiter characters emitted so far that the parser will read as literal
  // text — the ones that can still capture an opening delimiter further right.
  // Code spans, links and emphasis are closed constructs, so whatever they hold
  // can never reach out; only bare text contributes.
  let loose = "";
  nodes.forEach((node, i) => {
    const after = leadingChar(nodes[i + 1]);
    switch (node.type) {
      case "text":
        out += node.value;
        loose += node.value;
        break;
      case "code":
        out += "`" + node.value + "`";
        break;
      case "strong":
        out += wrapEmphasis(
          renderInline(node.children, underscoreFirst),
          underscoreFirst ? STRONG_DELIMS_ALT : STRONG_DELIMS,
          loose,
          after,
        );
        break;
      case "em":
        out += wrapEmphasis(
          renderInline(node.children, underscoreFirst),
          underscoreFirst ? EM_DELIMS_ALT : EM_DELIMS,
          loose,
          after,
        );
        break;
      case "link":
        out += `[${renderInline(node.children, underscoreFirst)}](${node.href})`;
        break;
    }
  });
  return out;
}

/** Serialize one inline run back to Markdown.
 *
 * The delimiter rules above are local, but the parser's leftmost-match scan is
 * not: a dangling `*` earlier in a text node can capture the opening delimiter
 * of an em run several nodes later (`*a` + em(`a`) must not render `*a*a*`).
 * Rather than model that, the run is rendered and then CHECKED against the real
 * parser; if the asterisk-first rendering does not read back, the whole run is
 * re-rendered underscore-first. Two renders and two parses, only ever on an
 * inline run — cheap, and it makes the round trip a verified property of the
 * output instead of a property of the heuristics. */
export function serializeInline(nodes: InlineNode[]): string {
  if (!nodes.length) return "";
  const asterisksFirst = renderInline(nodes, false);
  if (sameInlines(parseInline(asterisksFirst), nodes)) return asterisksFirst;
  const underscoresFirst = renderInline(nodes, true);
  return sameInlines(parseInline(underscoresFirst), nodes) ? underscoresFirst : asterisksFirst;
}

function sameInlines(a: InlineNode[], b: InlineNode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((node, i) => {
    const other = b[i];
    if (node.type !== other.type) return false;
    switch (node.type) {
      case "text":
      case "code":
        return node.value === (other as typeof node).value;
      case "link":
        return (
          node.href === (other as typeof node).href &&
          sameInlines(node.children, (other as typeof node).children)
        );
      default:
        return sameInlines(node.children, (other as { children: InlineNode[] }).children);
    }
  });
}

// --- blocks -----------------------------------------------------------------

// The parser closes a fence on a line of *only* backticks (or only tildes), so
// a fence marker is safe exactly when the block body contains no such line.
const BACKTICK_FENCE_LINE = /^\s*`{3,}\s*$/;
const TILDE_FENCE_LINE = /^\s*~{3,}\s*$/;

function fenceFor(text: string): string {
  const lines = text.split("\n");
  if (!lines.some((l) => BACKTICK_FENCE_LINE.test(l))) return "```";
  if (!lines.some((l) => TILDE_FENCE_LINE.test(l))) return "~~~";
  return "```";
}

function alignCell(align: ColumnAlign): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

/** Escape a serialized cell for a table row: the parser's `splitRow` treats
 * `\|` as a literal pipe and `\\` as a literal backslash, so both characters
 * are escaped wholesale. Safe to apply to the whole serialized run — this
 * dialect's inline syntax never emits a functional backslash, so every `\` in
 * serialized output is literal text. */
function escapeCell(serialized: string): string {
  return serialized.replace(/[\\|]/g, (c) => "\\" + c);
}

function tableRow(cells: InlineNode[][]): string {
  return `| ${cells.map((cell) => escapeCell(serializeInline(cell))).join(" | ")} |`;
}

/** Is `source` a single paragraph and nothing else? */
function isLoneParagraph(source: string): boolean {
  const blocks = parseMaterialDoc(source).blocks;
  return blocks.length === 1 && blocks[0].type === "paragraph";
}

/** Does `source` read back as exactly this one paragraph? The oracle for
 * paragraph line-breaking below — asking the real parser instead of
 * re-implementing its block-boundary rules here, so the two cannot drift. */
function readsBackAsParagraph(source: string, inlines: InlineNode[]): boolean {
  const blocks = parseMaterialDoc(source).blocks;
  const only = blocks.length === 1 ? blocks[0] : null;
  return only !== null && only.type === "paragraph" && sameInlines(only.inlines, inlines);
}

/** Break a paragraph's text back across the soft-wrapped lines the parser
 * rejoins with a single space, cutting wherever a line would otherwise open a
 * different block. */
function softWrap(text: string): string {
  const words = text.split(" ");
  const lines: string[] = [];
  for (let i = 0; i < words.length;) {
    let line = words[i];
    i++;
    // Keep the line as long as it still reads as prose on its own.
    while (i < words.length && isLoneParagraph(`${line} ${words[i]}`)) {
      line = `${line} ${words[i]}`;
      i++;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Render a paragraph, reshaping it if its one-line form would open a
 * different block.
 *
 * A paragraph's text can start with a block marker — the parser produces
 * `"* ]"` from the two lines `*` and `]` (a lone `*` is not a list marker but
 * `* ]` is), and `"### x"` from `" ### x"` (a heading marker must be at column
 * zero, but the parser trims the line). With no escape syntax available, the
 * two lossless reshapes are the ones the parser itself undoes: the single space
 * it trims off a line, and the space it rejoins soft-wrapped lines with. Each
 * candidate is checked against the parser, so the common case costs one parse
 * and changes nothing. */
function serializeParagraph(inlines: InlineNode[]): string {
  const text = serializeInline(inlines);
  if (readsBackAsParagraph(text, inlines)) return text;

  const indent = (source: string) =>
    source
      .split("\n")
      .map((line) => ` ${line}`)
      .join("\n");

  // The underscore-first rendering is the third reshape: `*\ttext*` opens a
  // list where `_\ttext_` is prose, and both are valid inline Markdown.
  const alternate = renderInline(inlines, true);
  const usable = sameInlines(parseInline(alternate), inlines) ? alternate : text;

  // The escape candidates come FIRST: `\# note` is safe in every adjacency
  // (a backslash-led line at column zero never continues a preceding list),
  // whereas the leading-space and indent reshapes read as continuation content
  // when the paragraph directly follows a list — validating them in isolation
  // is not enough. They are kept as fallbacks for collisions an escape cannot
  // express (the parser only sheds a backslash before an escapable character).
  const candidates = [
    `\\${text}`,
    softWrap(text),
    ` ${text}`,
    indent(softWrap(text)),
    usable,
    `\\${usable}`,
    ` ${usable}`,
    softWrap(usable),
  ];
  for (const candidate of candidates) {
    if (readsBackAsParagraph(candidate, inlines)) return candidate;
  }
  return text;
}

/** Prefix every line of a rendered chunk, leaving blank lines bare so the
 * output carries no trailing whitespace. `>` and `> ` both strip to "" in the
 * parser, and an indented blank line is meaningless inside a list item. */
function prefixLines(chunk: string, prefix: string): string {
  return chunk
    .split("\n")
    .map((line) => (line ? prefix + line : prefix.trimEnd()))
    .join("\n");
}

/** Does this head line read back as exactly this one item? The oracle for
 * item-head protection below — same pattern as `readsBackAsParagraph`, asking
 * the real parser instead of copying its TASK/HR rules here. */
function readsBackAsItemHead(headLine: string, item: ListItem): boolean {
  const blocks = parseMaterialDoc(headLine).blocks;
  const only = blocks.length === 1 && blocks[0].type === "list" ? blocks[0] : null;
  if (!only || only.items.length !== 1) return false;
  const parsed = only.items[0];
  return parsed.checked === item.checked && sameInlines(parsed.inlines, item.inlines);
}

function serializeListItem(item: ListItem, marker: string): string {
  const task = item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
  const text = serializeInline(item.inlines);
  // The trailing space matters for an empty item: `-` alone is not a marker.
  let head = `${marker} ${task}${text}`;
  // Teacher-typed text can collide with item-head syntax in ways no reshape
  // expresses: "[x] like this" as PLAIN text reads back as a checkbox with the
  // prefix eaten, "---" as `- ---` reads back as a divider, and a literal
  // leading backslash would be shed by the parser's own unescape. One leading
  // `\` (which the parser strips in item-head position) covers all three;
  // verified against the real parser, so the common case costs one parse and
  // changes nothing.
  if (!readsBackAsItemHead(head, item)) {
    const escaped = `${marker} ${task}\\${text}`;
    if (readsBackAsItemHead(escaped, item)) head = escaped;
  }
  if (!item.children.length) return head;
  // The parser folds continuation lines by slicing exactly `indent + 2`
  // characters, so nested content is indented by exactly two spaces.
  return `${head}\n${prefixLines(serializeBlocks(item.children), "  ")}`;
}

/** Serialize a single block back to its Markdown source — the primitive a
 * per-block editor (MATERIAL_EDITING phase 4) round-trips through: show this in
 * an editable field, then reparse the edited text with `parseBlockText`. See
 * that function's own comment for why editing goes through the whole-block
 * form (fence included for `code`, `> ` prefix included for `quote`) rather
 * than a narrower per-field one. */
export function serializeBlock(block: MaterialBlock): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.level)} ${serializeInline(block.inlines)}`;
    case "paragraph":
      return serializeParagraph(block.inlines);
    case "divider":
      return "---";
    case "image":
      // Both fields are sanitized rather than escaped: the dialect has no
      // general escape (see this file's header), and the parser reads an alt
      // as `[^\]]*` and a src as `[^)\s]+`, so a stray `]`/newline/paren would
      // silently reshape the block on the next reparse. The editors sanitize
      // on input too — this is the backstop that keeps the round-trip
      // contract true for a body that arrived some other way (AI output, a
      // hand-edited body).
      return `![${sanitizeImageAlt(block.alt)}](${sanitizeImageSrc(block.src)})`;
    case "code": {
      const fence = fenceFor(block.text);
      return `${fence}${block.lang ?? ""}\n${block.text}\n${fence}`;
    }
    case "timeline": {
      // Always backticks: `serializeTimeline` sanitizes every label onto one
      // line behind its own directive keyword, so no body line can consist of
      // fence characters alone and there is nothing for `fenceFor` to dodge.
      // A block with no marker at all would read back as a CODE block rather
      // than a timeline — that is the unrepresentable state
      // `isRepresentableTimeline` exists to keep the editors from producing.
      return `\`\`\`${TIMELINE_LANG}\n${serializeTimeline(block)}\n\`\`\``;
    }
    case "list":
      return block.items
        .map((item, i) => serializeListItem(item, block.ordered ? `${i + 1}.` : "-"))
        .join("\n");
    case "table":
      return [
        tableRow(block.header),
        `| ${block.align.map(alignCell).join(" | ")} |`,
        ...block.rows.map(tableRow),
      ].join("\n");
    case "quote":
      return prefixLines(serializeBlocks(block.blocks), "> ");
    case "callout": {
      const title = block.title ? ` ${serializeInline(block.title)}` : "";
      const head = `> [!${block.variant}]${title}`;
      if (!block.blocks.length) return head;
      return `${head}\n${prefixLines(serializeBlocks(block.blocks), "> ")}`;
    }
  }
}

/** How many blank lines must sit between two adjacent blocks. One is the norm;
 * two consecutive lists of the same family need two, because the parser folds a
 * single blank line back into the first list. */
function separator(previous: MaterialBlock, next: MaterialBlock): string {
  if (previous.type === "list" && next.type === "list" && previous.ordered === next.ordered) {
    return "\n\n\n";
  }
  return "\n\n";
}

/** Serialize a run of blocks — the unit a section editor sends to the AI refine
 * endpoint, and what `serializeMaterialDoc` wraps. */
export function serializeBlocks(blocks: MaterialBlock[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    if (i > 0) out += separator(blocks[i - 1], block);
    out += serializeBlock(block);
  });
  return out;
}

/** Serialize a whole document back to a material `body`. Pure, deterministic
 * and the inverse of `parseMaterialDoc` up to normalization. */
export function serializeMaterialDoc(doc: MaterialDoc): string {
  return serializeBlocks(doc.blocks);
}
