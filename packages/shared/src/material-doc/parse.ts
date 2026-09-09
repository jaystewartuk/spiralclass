import { parseTimeline, TIMELINE_LANG, timelineTextLines } from "./timeline";
import type { ColumnAlign, InlineNode, ListItem, MaterialBlock, MaterialDoc } from "./types";
import { CALLOUT_VARIANTS, type CalloutVariant } from "./types";

// The one parser. Turns a material `body` — a constrained GFM-Markdown subset,
// optionally enriched with `> [!variant]` semantic callouts — into the typed
// MaterialDoc every renderer walks.
//
// WHY MARKDOWN STAYS THE WIRE FORMAT (and this is a parser, not a JSON schema):
//  - Streaming: the "watch it write" generator renders tokens as they
//    arrive. Markdown renders progressively; a JSON document tree does not parse
//    until the final byte. This parser is resilient to a truncated tail, so a
//    half-streamed body still yields a valid partial doc.
//  - Zero migration: every existing material `body` in the DB is already this
//    Markdown. Parsing it means no backfill, no dual-write, no risk to prod —
//    old content simply renders with the new design (minus callouts it never
//    had), new content opts into callouts. Graceful degradation by construction.
//  - Robustness: an LLM emits valid Markdown far more reliably than valid JSON;
//    a stray token degrades one block here instead of failing the whole document.
//
// Dependency-free on purpose: it must run byte-identically under Node (web SSR +
// tests), the browser, and the react-pdf pipeline. That is the guarantee that
// all three surfaces agree.
//
// It NEVER produces an HTML sink — only the known node set below — which is the
// same sanitisation boundary the old renderers documented (D-17). Link hrefs are
// carried verbatim; each renderer applies its own scheme allow-list at the sink.

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const QUOTE = /^\s*>\s?/;
// Ordered/unordered list markers, capturing leading indent so nested lists work.
const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
// `> [!tip] optional title` — the callout marker on a blockquote's first line.
const CALLOUT_MARKER = /^\[!\s*([a-zA-Z]+)\s*\]\s*(.*)$/;
// `![alt](src)` ALONE on a line — a block-level image. Anchored on both ends on
// purpose: an image mid-sentence stays literal text, because MaterialBlock has
// no inline image and the renderers would have nowhere to put one.
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

const VARIANT_SET = new Set<string>(CALLOUT_VARIANTS);

// --- the minimal escape ------------------------------------------------------
//
// The dialect deliberately has no general backslash escape (see serialize.ts's
// header), but teacher-typed text from the per-block editors can collide with
// block syntax in ways no serializer reshape can express: a list item whose
// text IS "[x] like this" (reads back as a checkbox), an item of only dashes
// (reads back as a divider), a table cell containing "|". For exactly those
// line-start and cell positions, a single leading backslash protects the next
// character, mirroring GFM. Scoped on purpose:
//  - `\|` (and `\\`) inside a table ROW — GFM's own escape, which also fixes
//    AI-emitted tables that already escape pipes the standard way.
//  - one leading `\` on a PARAGRAPH line or LIST-ITEM head, only before a
//    character that could open a different construct there.
// Inline text everywhere else still carries backslashes verbatim. For old
// stored bodies this is a strict improvement: `\* word` used to render with a
// visible backslash and now renders as the author meant.
const PARA_ESCAPABLE = /^[-*+#>`~!\d\\]/;
const ITEM_ESCAPABLE = /^[[\-*_\\]/;

function unescapeLineStart(text: string, escapable: RegExp): string {
  return text.startsWith("\\") && escapable.test(text.slice(1)) ? text.slice(1) : text;
}

/** Is the character at `i` preceded by an odd run of backslashes? */
function isEscapedAt(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

function isBlockBoundary(line: string): boolean {
  return (
    !line.trim() ||
    HEADING.test(line) ||
    HR.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    UL.test(line) ||
    OL.test(line) ||
    IMAGE.test(line.trim())
  );
}

function splitRow(line: string): string[] {
  let s = line.trim().replace(/^\|/, "");
  if (s.endsWith("|") && !isEscapedAt(s, s.length - 1)) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && (s[i + 1] === "|" || s[i + 1] === "\\")) {
      cell += s[i + 1]; // `\|` → literal pipe, `\\` → literal backslash
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseAlign(sepCells: string[]): ColumnAlign[] {
  return sepCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

// --- inline -----------------------------------------------------------------

// One alternation, tried left-to-right so `**` beats `*` and `__` beats `_`.
// Groups: 1 code, 2/3 strong, 4/5 em, 6 link.
const INLINE =
  /(`[^`]+`)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(\*[\s\S]+?\*)|(_[\s\S]+?_)|(\[[^\]]+\]\([^)\s]+\))/;

export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let rest = text;

  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += value;
    else out.push({ type: "text", value });
  };

  while (rest.length) {
    const m = INLINE.exec(rest);
    if (!m) {
      pushText(rest);
      break;
    }
    if (m.index > 0) pushText(rest.slice(0, m.index));
    const tok = m[0];

    if (m[1]) {
      out.push({ type: "code", value: tok.slice(1, -1) });
    } else if (m[2] || m[3]) {
      out.push({ type: "strong", children: parseInline(tok.slice(2, -2)) });
    } else if (m[4] || m[5]) {
      out.push({ type: "em", children: parseInline(tok.slice(1, -1)) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (link) {
        out.push({ type: "link", href: link[2], children: parseInline(link[1]) });
      } else {
        pushText(tok);
      }
    }
    rest = rest.slice(m.index + tok.length);
  }

  return out.length ? out : [{ type: "text", value: "" }];
}

// --- blocks -----------------------------------------------------------------

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m ? m[1].replace(/\t/g, "  ").length : 0;
}

// Parse a full array of already-dedented lines into blocks. Used at the top
// level and recursively for callout/quote bodies (after stripping `>`).
function parseBlocks(lines: string[]): MaterialBlock[] {
  const blocks: MaterialBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code — verbatim until the closing fence of the same marker.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const lang = fence[3] || null;
      const buf: string[] = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{3,}\\s*$`).test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or run off the end — tolerated)
      const text = buf.join("\n");
      // A `timeline`-tagged fence carries a drawn block rather than source to
      // typeset (see ./timeline.ts for why a fence is the spelling). It is
      // read STRICTLY: a body this parser can't fully understand — a mistyped
      // directive, a half-streamed payload, a payload with no marker at all —
      // stays the code block it already parsed as, so the author's text is
      // shown verbatim instead of half-drawn or quietly dropped. No entry in
      // `isBlockBoundary` is needed: FENCE is already one.
      if (lang && lang.toLowerCase() === TIMELINE_LANG) {
        const timeline = parseTimeline(text);
        if (timeline) {
          blocks.push(timeline);
          continue;
        }
      }
      blocks.push({ type: "code", text, lang });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, inlines: parseInline(heading[2].trim()) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "divider" });
      i++;
      continue;
    }

    // A standalone image. Checked before the table/list/paragraph cases so the
    // line is never folded into a surrounding paragraph; `src` is carried
    // verbatim, and each renderer allow-lists it at its own sink (see
    // ./images.ts) exactly as it already does for a link href.
    const image = IMAGE.exec(line.trim());
    if (image) {
      blocks.push({ type: "image", src: image[2], alt: image[1].trim() });
      i++;
      continue;
    }

    // GFM table: a header row directly followed by a `|---|:--:|` separator.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("-") &&
      TABLE_SEP.test(lines[i + 1])
    ) {
      const header = splitRow(line).map(parseInline);
      const align = parseAlign(splitRow(lines[i + 1]));
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", header, rows, align });
      continue;
    }

    // Blockquote / callout — gather the contiguous `>`-prefixed run.
    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      const marker = CALLOUT_MARKER.exec(buf[0]?.trim() ?? "");
      const variant =
        marker && VARIANT_SET.has(marker[1].toLowerCase())
          ? (marker[1].toLowerCase() as CalloutVariant)
          : null;
      if (variant) {
        const titleText = marker![2].trim();
        const body = buf.slice(1);
        blocks.push({
          type: "callout",
          variant,
          title: titleText ? parseInline(titleText) : null,
          blocks: parseBlocks(body),
        });
      } else {
        blocks.push({ type: "quote", blocks: parseBlocks(buf) });
      }
      continue;
    }

    // Lists (ordered/unordered, with GFM task items and indentation nesting).
    if (UL.test(line) || OL.test(line)) {
      const consumed = parseList(lines, i);
      blocks.push(consumed.block);
      i = consumed.next;
      continue;
    }

    // Paragraph — consecutive non-boundary lines joined with a space. Each
    // line sheds at most one protective leading backslash (see the escape
    // comment above) before joining.
    const buf: string[] = [unescapeLineStart(line.trim(), PARA_ESCAPABLE)];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockBoundary(lines[i])) {
      buf.push(unescapeLineStart(lines[i].trim(), PARA_ESCAPABLE));
      i++;
    }
    blocks.push({ type: "paragraph", inlines: parseInline(buf.join(" ")) });
  }

  return blocks;
}

// Parse one contiguous list starting at `start`. A list runs while items share
// the same marker family (ordered vs unordered) at the same base indent. Lines
// indented past the marker are folded into the current item as nested blocks
// (sub-lists, wrapped text), parsed recursively. A single blank line between
// items is tolerated; anything else ends the list. Returns the list block and
// the index of the first unconsumed line.
function parseList(lines: string[], start: number): { block: MaterialBlock; next: number } {
  const first = (UL.exec(lines[start]) ?? OL.exec(lines[start]))!;
  const baseIndent = first[1].length;
  const ordered = OL.test(lines[start]);
  const marker = ordered ? OL : UL;
  const items: ListItem[] = [];
  let i = start;

  const startsItemHere = (line: string): boolean => {
    const m = marker.exec(line);
    return Boolean(m && m[1].length === baseIndent);
  };

  while (i < lines.length) {
    // Skip at most one blank line, and only if a sibling item follows it.
    if (!lines[i].trim()) {
      if (i + 1 < lines.length && startsItemHere(lines[i + 1])) {
        i++;
        continue;
      }
      break;
    }

    const m = marker.exec(lines[i]);
    if (!m || m[1].length !== baseIndent) break; // de-indent or different family

    let content = m[3];
    const task = TASK.exec(content);
    let checked: boolean | null = null;
    if (task) {
      checked = task[1].toLowerCase() === "x";
      content = task[2];
    }

    // Gather the item's nested/continuation lines: everything indented past the
    // marker, plus blank lines that are themselves followed by such content.
    const nested: string[] = [];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        if (i + 1 < lines.length && indentOf(lines[i + 1]) > baseIndent) {
          nested.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) > baseIndent) {
        nested.push(l.slice(baseIndent + 2));
        i++;
        continue;
      }
      break;
    }

    items.push({
      inlines: parseInline(unescapeLineStart(content.trim(), ITEM_ESCAPABLE)),
      checked,
      children: nested.length ? parseBlocks(nested) : [],
    });
  }

  return { block: { type: "list", ordered, items }, next: i };
}

/** Parse a material `body` into the canonical document model. Pure and
 * deterministic, so renderers can memoise on the `body` string. */
export function parseMaterialDoc(body: string): MaterialDoc {
  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n");
  return { blocks: parseBlocks(lines) };
}

/** Parse a single block's edited Markdown source back into blocks — the
 * inverse of `serializeBlock` (serialize.ts), and the primitive a per-block
 * editor (MATERIAL_EDITING phase 4) reparses an "edit as text" field through.
 * 0, 1 or several blocks can come back: an emptied field deletes the block,
 * and text that opens a different block type (e.g. "- item" typed into what
 * was a paragraph) promotes it — the same "whatever it parses to" rule the
 * section-level AI-refine splice already applies one level up. Just
 * `parseMaterialDoc(text).blocks`, named for the call site's intent. */
export function parseBlockText(text: string): MaterialBlock[] {
  return parseMaterialDoc(text).blocks;
}

/** Does this doc contain a homework/exercise callout, at any nesting depth?
 * Used to decide whether a class-content save should auto-draft a real
 * Assignment (docs/features/homework.md) — a teacher's
 * `[!homework]`/`[!exercise]` box is otherwise just styled prose with no
 * connection to the submittable Assignment model. */
export function hasHomeworkCallout(doc: MaterialDoc): boolean {
  const isHomeworkCallout = (b: MaterialBlock): boolean =>
    b.type === "callout" && (b.variant === "homework" || b.variant === "exercise");
  const scan = (blocks: MaterialBlock[]): boolean =>
    blocks.some((b) => {
      if (isHomeworkCallout(b)) return true;
      if (b.type === "callout" || b.type === "quote") return scan(b.blocks);
      if (b.type === "list") return b.items.some((item) => scan(item.children));
      return false;
    });
  return scan(doc.blocks);
}

function inlinesToText(inlines: InlineNode[]): string {
  return inlines
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "code":
          return n.value;
        case "strong":
        case "em":
        case "link":
          return inlinesToText(n.children);
      }
    })
    .join("");
}

const HOMEWORK_EXCERPT_VARIANTS = new Set<CalloutVariant>(["homework", "exercise", "answer"]);

function blockToExcerptLines(b: MaterialBlock): string[] {
  switch (b.type) {
    case "heading":
    case "paragraph":
      return [inlinesToText(b.inlines)];
    case "list":
      return b.items.flatMap((item) => [
        `- ${inlinesToText(item.inlines)}`,
        ...item.children.flatMap(blockToExcerptLines),
      ]);
    case "callout":
      return [
        `[${b.variant}]${b.title ? " " + inlinesToText(b.title) : ""}`,
        ...b.blocks.flatMap(blockToExcerptLines),
      ];
    case "quote":
      return b.blocks.flatMap(blockToExcerptLines);
    case "code":
      return [b.text];
    case "table":
      return b.rows.map((row) => row.map((cell) => inlinesToText(cell)).join(" | "));
    // The alt text is the only part of an image a text-only consumer (the
    // homework-review prompt) can use — and for a "describe this picture"
    // exercise it is the whole prompt, so dropping it would strip the
    // question. The src is deliberately not included: a storage key is noise
    // to a model reading the excerpt.
    case "image":
      return b.alt ? [b.alt] : [];
    // A timeline inside an exercise is part of the question, so its labels
    // survive the flattening; its coordinates don't (see `timelineTextLines`).
    case "timeline":
      return timelineTextLines(b);
    case "divider":
      return [];
  }
}

/** Plain-text excerpt of just the homework/exercise/answer callouts in a
 * material, at any nesting depth — the focused input a homework AI review
 * prompt needs (docs/features/homework.md), without
 * duplicating the whole material body as stored text (computed at read time
 * from the live `body`, so it can never go stale). Returns "" when the
 * material has no such callout — callers should fall back to the whole body
 * in that case (a manually-authored assignment with no material at all, or a
 * material whose homework content isn't in a recognized callout). */
export function extractHomeworkExcerptText(doc: MaterialDoc): string {
  const collect = (blocks: MaterialBlock[]): string[] =>
    blocks.flatMap((b) => {
      if (b.type === "callout" && HOMEWORK_EXCERPT_VARIANTS.has(b.variant)) {
        return blockToExcerptLines(b);
      }
      if (b.type === "callout" || b.type === "quote") return collect(b.blocks);
      if (b.type === "list") return b.items.flatMap((item) => collect(item.children));
      return [];
    });
  return collect(doc.blocks).join("\n").trim();
}
