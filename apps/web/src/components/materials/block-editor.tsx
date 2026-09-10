"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns3,
  GitCommitHorizontal,
  ImagePlus,
  Info,
  List,
  Minus,
  Plus,
  Rows3,
  Table,
  Trash2,
  Type,
  X,
} from "lucide-react";
import {
  calloutMeta,
  clearTimelineSpan,
  defaultTimelineSpan,
  editBlockText,
  insertBlockAt,
  insertListItem,
  insertTableColumn,
  insertTableRow,
  insertTimelinePoint,
  moveListItem,
  newCalloutBlock,
  newDividerBlock,
  newImageBlock,
  newListBlock,
  newParagraphBlock,
  newTableBlock,
  newTimelineBlock,
  parseMaterialDoc,
  removeBlockAt,
  removeListItem,
  removeTableColumn,
  removeTableRow,
  removeTimelinePoint,
  serializeBlock,
  serializeBlocks,
  serializeInline,
  setTimelineSpan,
  toggleListItemChecked,
  updateBlockAt,
  updateCalloutTitle,
  updateCalloutVariant,
  updateImageAlt,
  updateImageSrc,
  updateListItemText,
  updateTableCell,
  updateTimelineLabel,
  updateTimelinePointAt,
  updateTimelinePointLabel,
  updateTimelineSpanLabel,
  CALLOUT_VARIANTS,
  TIMELINE_MAX,
  TIMELINE_MAX_POINTS,
  TIMELINE_MIN,
  TIMELINE_NOW,
  type CalloutBlock,
  type CalloutVariant,
  type EditorSection,
  type ImageBlock,
  type ListBlock,
  type MaterialBlock,
  type SectionAction,
  type TableBlock,
  type TimelineBlock,
} from "@spiralclass/shared";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/materials/icon-button";
import { ICONS, MaterialDocument } from "@/components/materials/material-document";
import { useT } from "@/components/locale-provider";
import { MATERIAL_IMAGE_ACCEPT, uploadMaterialImageFile } from "@/lib/materials/upload-image";
import { cn } from "@/lib/utils";

// The per-block editor (Phases 4–5 of the material-editing design).
// PREVIEW-FIRST (Phase 5): every block renders in
// read mode — exactly what the student sees, via MaterialDocument, no chrome
// — and a tap/click/Enter on it swaps in that one block's editor. One block
// per list edits at a time; committing (blur out of the block, or its Done
// button) returns it to read mode. This is what keeps a 10-section material
// roughly the length of the material itself instead of ~40 always-open
// textareas + previews. All structural change still goes through the flat
// block-list ops in @spiralclass/shared (packages/shared/src/material-doc/
// block-editor.ts), which is the ONLY implementation of "what a block edit
// does" — this component is a dispatcher over it, exactly like
// material-editor.tsx is a dispatcher over the section-level ops one level up.
//
// Composition IS the recursion: a callout's own body blocks are edited by
// mounting another BlockListEditor scoped to `callout.blocks`, wired back
// through `updateBlockAt` at the callout's own index in its parent list. The
// shared ops themselves stay flat (see that module's header) — nesting is a
// property of this component tree, not of the ops. Preview-first composes the
// same way: a callout reads whole; entering it reveals its nested list, whose
// blocks are again read-first with their own edit target.
//
// Every "edit as text" field (paragraph, quote, code) commits on BLUR, not on
// every keystroke: reparsing on every keystroke would let a serialize-time
// normalization (e.g. `__bold__` -> `**bold**`) snap the field's own text
// out from under an in-progress keystroke. The live preview beside it,
// though, re-renders on every keystroke — it reads the raw typed text
// directly, with no round trip through the shared editor state.

/** Local edit-in-progress state for one text field, resynced from the
 * committed value only while the field isn't focused — so an external change
 * (undo, another block's edit reflowing this one) is picked up, but the
 * field's own in-progress keystrokes are never overwritten mid-edit. Commits
 * on blur. */
function useDeferredText(committed: string, onCommit: (text: string) => void) {
  const [value, setValue] = useState(committed);
  const [focused, setFocused] = useState(false);
  if (!focused && value !== committed) setValue(committed);
  return {
    value,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      if (value !== committed) onCommit(value);
    },
  };
}

/** The section-scoped entry point: replaces the read-only body preview
 * inside a section card. Splits the section's own heading (untouched by
 * Phase 4 — a section's title isn't block-editable) from its body blocks,
 * hands the body to `BlockListEditor`, and reassembles + dispatches on every
 * change. */
export function SectionBlockEditor({
  section,
  onAction,
}: {
  section: EditorSection;
  onAction: (action: SectionAction) => void;
}) {
  const doc = useMemo(() => parseMaterialDoc(section.markdown), [section.markdown]);
  const heading = section.level !== null ? doc.blocks[0] : null;
  const bodyBlocks = heading ? doc.blocks.slice(1) : doc.blocks;

  function commit(nextBody: MaterialBlock[]) {
    const blocks = heading ? [heading, ...nextBody] : nextBody;
    onAction({ kind: "editBlocks", index: section.index, markdown: serializeBlocks(blocks) });
  }

  return <BlockListEditor blocks={bodyBlocks} onChange={commit} />;
}

/** A flat list of blocks — read-first, tap-to-edit — with an "add a block
 * here" slot before the first one and after every one. Used for a section's
 * own body AND, recursively, for a callout's nested body — the same
 * component, just scoped to a different (still flat) array.
 *
 * The edit target is UI state, not document state: block indices shift on
 * insert/delete, so every structural action clears it rather than trying to
 * follow the block. The slots are hover/focus-revealed (they were ~41 always-
 * visible rows on a large material) — except the last one, which stays
 * visible so an empty section is never a dead end. */
function BlockListEditor({
  blocks,
  onChange,
}: {
  blocks: MaterialBlock[];
  onChange: (next: MaterialBlock[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);

  function changeStructural(next: MaterialBlock[]) {
    setEditing(null);
    onChange(next);
  }

  return (
    <div className="group/blocklist space-y-1.5">
      <AddBlockRow
        subdued={blocks.length > 0}
        onAdd={(block) => changeStructural(insertBlockAt(blocks, 0, block))}
      />
      {blocks.map((block, i) => (
        <div key={i} className="space-y-1.5">
          <EditableBlock
            block={block}
            editing={editing === i}
            onEnterEdit={() => setEditing(i)}
            onExitEdit={() => setEditing((prev) => (prev === i ? null : prev))}
            onChange={(next) => onChange(updateBlockAt(blocks, i, next))}
            onEditText={(text) => onChange(editBlockText(blocks, i, text))}
            onDelete={() => changeStructural(removeBlockAt(blocks, i))}
          />
          <AddBlockRow
            subdued={i < blocks.length - 1}
            onAdd={(block) => changeStructural(insertBlockAt(blocks, i + 1, block))}
          />
        </div>
      ))}
    </div>
  );
}

/** One block: the student-facing render (read mode) until activated, then
 * that block's editor until focus leaves it or its Done is pressed.
 *
 * The read region is a `div[role="button"]`, not a `<button>` — the rendered
 * block can itself contain links, and interactive content may not nest
 * inside a real button. Clicks on a link inside the block navigate instead
 * of entering edit mode. Focus is managed explicitly: entering moves it into
 * the block's first field; exiting returns it to the read region IF the
 * unmounting editor stranded it on <body> (an exit caused by clicking
 * elsewhere keeps the user's chosen focus). */
function EditableBlock({
  block,
  editing,
  onEnterEdit,
  onExitEdit,
  onChange,
  onEditText,
  onDelete,
}: {
  block: MaterialBlock;
  editing: boolean;
  onEnterEdit: () => void;
  onExitEdit: () => void;
  onChange: (next: MaterialBlock) => void;
  onEditText: (text: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const readRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<HTMLDivElement | null>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing && !wasEditing.current) {
      const field =
        editRef.current?.querySelector<HTMLElement>("textarea, input") ??
        editRef.current?.querySelector<HTMLElement>("button");
      field?.focus();
    } else if (!editing && wasEditing.current) {
      if (document.activeElement === document.body || document.activeElement === null) {
        readRef.current?.focus();
      }
    }
    wasEditing.current = editing;
  }, [editing]);

  if (editing) {
    return (
      <div
        ref={editRef}
        onBlur={(e) => {
          // Exit only when focus leaves the whole block editor — moving
          // between a block's own fields (textarea → its delete button) must
          // not tear the editor down mid-interaction.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onExitEdit();
        }}
      >
        <BlockEditor
          block={block}
          onChange={onChange}
          onEditText={onEditText}
          onDelete={onDelete}
          onDone={onExitEdit}
        />
      </div>
    );
  }

  return (
    <div
      ref={readRef}
      role="button"
      tabIndex={0}
      aria-label={t("material.editor.block.editThis")}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a")) onEnterEdit();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEnterEdit();
        }
      }}
      className="group/readblock hover:bg-muted/30 focus-visible:ring-ring relative cursor-pointer rounded-md px-2 py-1 focus-visible:ring-1 focus-visible:outline-none"
    >
      <MaterialDocument body={serializeBlock(block)} />
      <span className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/readblock:opacity-100 focus-within:opacity-100">
        <IconButton
          label={t("material.editor.block.delete")}
          destructive
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      </span>
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
  onEditText,
  onDelete,
  onDone,
}: {
  block: MaterialBlock;
  onChange: (next: MaterialBlock) => void;
  onEditText: (text: string) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "code":
      return (
        <RawTextBlockEditor
          block={block}
          onEditText={onEditText}
          onDelete={onDelete}
          onDone={onDone}
        />
      );
    case "list":
      return (
        <ListBlockEditor block={block} onChange={onChange} onDelete={onDelete} onDone={onDone} />
      );
    case "callout":
      return (
        <CalloutBlockEditor block={block} onChange={onChange} onDelete={onDelete} onDone={onDone} />
      );
    case "table":
      return (
        <TableBlockEditor block={block} onChange={onChange} onDelete={onDelete} onDone={onDone} />
      );
    case "image":
      return (
        <ImageBlockEditor block={block} onChange={onChange} onDelete={onDelete} onDone={onDone} />
      );
    case "timeline":
      return (
        <TimelineBlockEditor
          block={block}
          onChange={onChange}
          onDelete={onDelete}
          onDone={onDone}
        />
      );
    case "divider":
      return <DividerBlockEditor onDelete={onDelete} onDone={onDone} />;
    case "heading":
      // Unreachable in practice — SectionBlockEditor strips the section's own
      // heading before any block reaches here, and nothing on the add-block
      // menu inserts one. Handled only for MaterialBlock exhaustiveness.
      return null;
  }
}

/** Chrome shared by every block type IN EDIT MODE: a thin header (a label,
 * Done, delete) and the type's own content below it. Read mode renders no
 * chrome at all — this only ever appears on the one active block. */
function BlockChrome({
  label,
  onDelete,
  onDone,
  children,
}: {
  label: string;
  onDelete: () => void;
  onDone: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="rounded-md border">
      <div className="bg-muted/30 flex items-center gap-1 border-b px-2 py-1">
        <span className="text-muted-foreground flex-1 text-xs font-medium">{label}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("material.editor.block.done")}
        </Button>
        <IconButton label={t("material.editor.block.delete")} destructive onClick={onDelete}>
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

/** Paragraph, quote and code all edit as one Markdown-source text field,
 * reparsed on blur via the shared `editBlockText` — see this file's header
 * for why "edit as text" always means the whole block's own serialized form
 * (fence included for code, `> ` included for quote), not a narrower one. */
const RAW_TEXT_TYPE_KEY = {
  paragraph: "material.editor.block.type.paragraph",
  quote: "material.editor.block.type.quote",
  code: "material.editor.block.type.code",
} as const;

function RawTextBlockEditor({
  block,
  onEditText,
  onDelete,
  onDone,
}: {
  block: Extract<MaterialBlock, { type: "paragraph" | "quote" | "code" }>;
  onEditText: (text: string) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const field = useDeferredText(serializeBlock(block), onEditText);

  return (
    <BlockChrome label={t(RAW_TEXT_TYPE_KEY[block.type])} onDelete={onDelete} onDone={onDone}>
      <Textarea
        {...field}
        rows={block.type === "paragraph" ? 3 : 5}
        placeholder={t("material.editor.block.textPlaceholder")}
        className={block.type === "code" ? "font-mono text-sm" : undefined}
      />
      {field.value.trim() && (
        <div className="bg-muted/20 mt-2 rounded-md border px-3 py-2">
          <MaterialDocument body={field.value} />
        </div>
      )}
    </BlockChrome>
  );
}

function ListBlockEditor({
  block,
  onChange,
  onDelete,
  onDone,
}: {
  block: ListBlock;
  onChange: (next: MaterialBlock) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <BlockChrome label={t("material.editor.block.type.list")} onDelete={onDelete} onDone={onDone}>
      <div className="space-y-1.5">
        {block.items.map((item, i) => (
          <ListItemRow
            key={i}
            text={serializeInline(item.inlines)}
            checked={item.checked}
            isFirst={i === 0}
            isLast={i === block.items.length - 1}
            onTextCommit={(text) => onChange(updateListItemText(block, i, text))}
            onToggle={() => onChange(toggleListItemChecked(block, i))}
            onMoveUp={() => onChange(moveListItem(block, i, i - 1))}
            onMoveDown={() => onChange(moveListItem(block, i, i + 1))}
            onRemove={() => onChange(removeListItem(block, i))}
          />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange(
              insertListItem(block, block.items.length, t("material.editor.block.itemPlaceholder")),
            )
          }
        >
          <Plus className="mr-1 size-3.5" aria-hidden />
          {t("material.editor.block.addItem")}
        </Button>
      </div>
    </BlockChrome>
  );
}

function ListItemRow({
  text,
  checked,
  isFirst,
  isLast,
  onTextCommit,
  onToggle,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  text: string;
  checked: boolean | null;
  isFirst: boolean;
  isLast: boolean;
  onTextCommit: (text: string) => void;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const field = useDeferredText(text, onTextCommit);
  return (
    <div className="flex items-center gap-1.5">
      {checked !== null && (
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label={t("material.editor.block.toggleDone")}
        />
      )}
      <Input
        {...field}
        placeholder={t("material.editor.block.itemPlaceholder")}
        className="h-8 text-sm"
      />
      <IconButton
        label={t("material.editor.block.moveItemUp")}
        disabled={isFirst}
        onClick={onMoveUp}
      >
        <ChevronUp className="size-3.5" aria-hidden />
      </IconButton>
      <IconButton
        label={t("material.editor.block.moveItemDown")}
        disabled={isLast}
        onClick={onMoveDown}
      >
        <ChevronDown className="size-3.5" aria-hidden />
      </IconButton>
      <IconButton label={t("material.editor.block.removeItem")} destructive onClick={onRemove}>
        <Trash2 className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}

function CalloutBlockEditor({
  block,
  onChange,
  onDelete,
  onDone,
}: {
  block: CalloutBlock;
  onChange: (next: MaterialBlock) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const titleField = useDeferredText(block.title ? serializeInline(block.title) : "", (text) =>
    onChange(updateCalloutTitle(block, text)),
  );
  const meta = calloutMeta(block.variant);
  const Icon = ICONS[meta.icon] ?? Info;

  return (
    <div className="rounded-md border">
      <div className="bg-muted/30 flex items-center gap-2 border-b px-2 py-1.5">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <Select
          value={block.variant}
          onValueChange={(value) => onChange(updateCalloutVariant(block, value as CalloutVariant))}
        >
          <SelectTrigger
            className="h-8 w-auto min-w-36 text-xs"
            aria-label={t("material.editor.block.calloutVariantLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CALLOUT_VARIANTS.map((variant) => (
              <SelectItem key={variant} value={variant}>
                {t(calloutMeta(variant).labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          {...titleField}
          placeholder={t("material.editor.block.calloutTitlePlaceholder")}
          className="h-8 flex-1 text-sm"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("material.editor.block.done")}
        </Button>
        <IconButton label={t("material.editor.block.delete")} destructive onClick={onDelete}>
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      </div>
      <div className="ml-2 border-l-2 p-2 pl-4">
        <BlockListEditor
          blocks={block.blocks}
          onChange={(next) => onChange({ ...block, blocks: next })}
        />
      </div>
    </div>
  );
}

function TableBlockEditor({
  block,
  onChange,
  onDelete,
  onDone,
}: {
  block: TableBlock;
  onChange: (next: MaterialBlock) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const cols = block.header.length;

  return (
    <BlockChrome label={t("material.editor.block.type.table")} onDelete={onDelete} onDone={onDone}>
      <div className="space-y-2 overflow-x-auto">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(6rem, 1fr)) auto` }}
        >
          {block.header.map((cell, ci) => (
            <TableCellInput
              key={`h-${ci}`}
              value={serializeInline(cell)}
              onCommit={(text) => onChange(updateTableCell(block, -1, ci, text))}
              bold
            />
          ))}
          <IconButton
            label={t("material.editor.block.removeColumn")}
            disabled={cols <= 1}
            onClick={() => onChange(removeTableColumn(block, cols - 1))}
          >
            <Columns3 className="size-3.5" aria-hidden />
          </IconButton>
          {block.rows.map((row, ri) => (
            <Fragment key={ri}>
              {row.map((cell, ci) => (
                <TableCellInput
                  key={ci}
                  value={serializeInline(cell)}
                  onCommit={(text) => onChange(updateTableCell(block, ri, ci, text))}
                />
              ))}
              <IconButton
                label={t("material.editor.block.removeRow")}
                onClick={() => onChange(removeTableRow(block, ri))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </Fragment>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(insertTableRow(block, block.rows.length))}
          >
            <Rows3 className="mr-1 size-3.5" aria-hidden />
            {t("material.editor.block.addRow")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(insertTableColumn(block, cols))}
          >
            <Columns3 className="mr-1 size-3.5" aria-hidden />
            {t("material.editor.block.addColumn")}
          </Button>
        </div>
      </div>
    </BlockChrome>
  );
}

function TableCellInput({
  value,
  onCommit,
  bold,
}: {
  value: string;
  onCommit: (text: string) => void;
  bold?: boolean;
}) {
  const field = useDeferredText(value, onCommit);
  return <Input {...field} className={cn("h-8 text-sm", bold && "font-semibold")} />;
}

/** An image edits as its CAPTION plus a replace-the-picture button — there is
 * no "edit as text" field, because the only other field is an opaque storage
 * key that a teacher has no way to type correctly and every way to break. */
function ImageBlockEditor({
  block,
  onChange,
  onDelete,
  onDone,
}: {
  block: ImageBlock;
  onChange: (next: MaterialBlock) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const altField = useDeferredText(block.alt, (text) => onChange(updateImageAlt(block, text)));

  return (
    <BlockChrome label={t("material.editor.block.type.image")} onDelete={onDelete} onDone={onDone}>
      <div className="space-y-2">
        <MaterialDocument body={serializeBlock(block)} />
        <div className="flex items-center gap-2">
          <Input
            {...altField}
            placeholder={t("material.editor.block.imageAltPlaceholder")}
            aria-label={t("material.editor.block.imageAltLabel")}
            className="h-8 flex-1 text-sm"
          />
          <ImageUploadButton
            label={t("material.editor.block.imageReplace")}
            onUploaded={(src) => onChange(updateImageSrc(block, src))}
          />
        </div>
      </div>
    </BlockChrome>
  );
}

/** A file input dressed as a button, shared by "add an image" and "replace
 * this image". The upload happens BEFORE any block is written — see
 * `newImageBlock`: a block with no src has no Markdown form and would vanish
 * on the next round trip, so there is deliberately no empty-placeholder
 * state to fill in afterwards. */
function ImageUploadButton({
  label,
  onUploaded,
}: {
  label: string;
  onUploaded: (src: string) => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the input straight away so choosing the SAME file again still
    // fires a change event (a re-try after a failed upload).
    e.target.value = "";
    if (!file) return;

    setBusy(true);
    setError(null);
    const result = await uploadMaterialImageFile(
      file,
      t("material.editor.block.imageUploadFailed"),
    );
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onUploaded(result.src);
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus className="mr-1 size-3.5" aria-hidden />
        {busy ? t("material.editor.block.imageUploading") : label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={MATERIAL_IMAGE_ACCEPT}
        className="hidden"
        onChange={pick}
      />
      {error && <span className="text-destructive text-xs">{error}</span>}
    </span>
  );
}

/** A timeline edits as its labels and its marker positions — never as text.
 *
 * The block's Markdown form is a `timeline` fence of directives with numeric
 * positions (see @spiralclass/shared's material-doc/timeline.ts); a teacher
 * typing into that would be one mistyped word away from turning her diagram
 * back into a code block, which is exactly what the parser does with a payload
 * it can't read. So this offers the fields instead, and every one of them goes
 * through the shared ops, which normalize and enforce the "at least one marker"
 * rule that keeps the block representable. */
function TimelineBlockEditor({
  block,
  onChange,
  onDelete,
  onDone,
}: {
  block: TimelineBlock;
  onChange: (next: MaterialBlock) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const past = useDeferredText(block.labels.past, (text) =>
    onChange(updateTimelineLabel(block, "past", text)),
  );
  const now = useDeferredText(block.labels.now, (text) =>
    onChange(updateTimelineLabel(block, "now", text)),
  );
  const future = useDeferredText(block.labels.future, (text) =>
    onChange(updateTimelineLabel(block, "future", text)),
  );

  return (
    <BlockChrome
      label={t("material.editor.block.type.timeline")}
      onDelete={onDelete}
      onDone={onDone}
    >
      <div className="space-y-3">
        <MaterialDocument body={serializeBlock(block)} />

        <fieldset className="space-y-1.5">
          <legend className="text-muted-foreground text-xs font-medium">
            {t("material.editor.block.timelineAxis")}
          </legend>
          <div className="flex gap-1.5">
            <Input
              {...past}
              aria-label={t("material.editor.block.timelinePastLabel")}
              placeholder={t("material.editor.block.timelinePastLabel")}
              className="h-8 flex-1 text-sm"
            />
            <Input
              {...now}
              aria-label={t("material.editor.block.timelineNowLabel")}
              placeholder={t("material.editor.block.timelineNowLabel")}
              className="h-8 flex-1 text-sm"
            />
            <Input
              {...future}
              aria-label={t("material.editor.block.timelineFutureLabel")}
              placeholder={t("material.editor.block.timelineFutureLabel")}
              className="h-8 flex-1 text-sm"
            />
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-muted-foreground text-xs font-medium">
            {t("material.editor.block.timelineSpan")}
          </legend>
          {block.span ? (
            <div className="flex items-center gap-1.5">
              <TimelineTextInput
                value={block.span.label}
                onCommit={(text) => onChange(updateTimelineSpanLabel(block, text))}
                placeholder={t("material.editor.block.timelineSpanPlaceholder")}
                label={t("material.editor.block.timelineSpan")}
              />
              <TimelinePositionInput
                value={block.span.from}
                label={t("material.editor.block.timelineSpanStart")}
                onCommit={(at) =>
                  onChange(setTimelineSpan(block, at, block.span!.to, block.span!.label))
                }
              />
              <TimelinePositionInput
                value={block.span.to}
                label={t("material.editor.block.timelineSpanEnd")}
                onCommit={(at) =>
                  onChange(setTimelineSpan(block, block.span!.from, at, block.span!.label))
                }
              />
              <IconButton
                label={t("material.editor.block.timelineRemoveSpan")}
                destructive
                // Inert when the span is the timeline's only content: dropping
                // it would leave a block that reads back as a code block.
                disabled={block.points.length === 0}
                onClick={() => onChange(clearTimelineSpan(block))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const span = defaultTimelineSpan(block);
                onChange(setTimelineSpan(block, span.from, span.to, ""));
              }}
            >
              <Plus className="mr-1 size-3.5" aria-hidden />
              {t("material.editor.block.timelineAddSpan")}
            </Button>
          )}
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-muted-foreground text-xs font-medium">
            {t("material.editor.block.timelinePoints")}
          </legend>
          {block.points.map((point, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <TimelineTextInput
                value={point.label}
                onCommit={(text) => onChange(updateTimelinePointLabel(block, i, text))}
                placeholder={t("material.editor.block.timelinePointPlaceholder")}
                label={t("material.editor.block.timelinePoints")}
              />
              <TimelinePositionInput
                value={point.at}
                label={t("material.editor.block.timelinePosition")}
                onCommit={(at) => onChange(updateTimelinePointAt(block, i, at))}
              />
              <IconButton
                label={t("material.editor.block.timelineRemovePoint")}
                destructive
                disabled={block.points.length === 1 && !block.span}
                onClick={() => onChange(removeTimelinePoint(block, i))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={block.points.length >= TIMELINE_MAX_POINTS}
            onClick={() => onChange(insertTimelinePoint(block, TIMELINE_NOW, ""))}
          >
            <Plus className="mr-1 size-3.5" aria-hidden />
            {t("material.editor.block.timelineAddPoint")}
          </Button>
        </fieldset>
      </div>
    </BlockChrome>
  );
}

function TimelineTextInput({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder: string;
  label: string;
}) {
  const field = useDeferredText(value, onCommit);
  return (
    <Input {...field} aria-label={label} placeholder={placeholder} className="h-8 flex-1 text-sm" />
  );
}

/** A 0–100 position on the axis. Commits on blur like every other field here,
 * and a field left non-numeric commits nothing rather than snapping the marker
 * to 0 — `Number("")` is 0, which would silently drag a marker to the far past
 * the moment a teacher cleared the box to retype it. */
function TimelinePositionInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (at: number) => void;
}) {
  const field = useDeferredText(String(value), (text) => {
    const parsed = Number(text.trim());
    if (text.trim() && Number.isFinite(parsed)) onCommit(parsed);
  });
  return (
    <Input
      {...field}
      type="number"
      inputMode="numeric"
      min={TIMELINE_MIN}
      max={TIMELINE_MAX}
      aria-label={label}
      title={label}
      className="h-8 w-16 text-sm"
    />
  );
}

function DividerBlockEditor({ onDelete, onDone }: { onDelete: () => void; onDone: () => void }) {
  const t = useT();
  return (
    <BlockChrome
      label={t("material.editor.block.type.divider")}
      onDelete={onDelete}
      onDone={onDone}
    >
      <hr className="border-border" />
    </BlockChrome>
  );
}

/** The hairline "add a block" slot — collapsed to a "+" pill until tapped,
 * then a row of type chips (a "Callout" chip expands into the 14 variants).
 * No dropdown/popover primitive is installed in this repo, so this is a
 * plain conditionally-rendered panel rather than a floating menu — the same
 * choice `AddSectionRow` one level up already made.
 *
 * `subdued` slots (every one except the list's last) are invisible until the
 * block list is hovered or the slot is focused — in read mode the material
 * should look exactly like the student's version, with the affordances
 * appearing on intent. They keep their layout space, so revealing them never
 * shifts the page. */
function AddBlockRow({
  onAdd,
  subdued = false,
}: {
  onAdd: (block: MaterialBlock) => void;
  subdued?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [calloutOpen, setCalloutOpen] = useState(false);

  function close() {
    setOpen(false);
    setCalloutOpen(false);
  }

  function choose(block: MaterialBlock) {
    onAdd(block);
    close();
  }

  if (!open) {
    return (
      <div
        className={cn(
          "group flex items-center gap-2 py-0.5",
          subdued &&
            "opacity-0 transition-opacity group-hover/blocklist:opacity-100 focus-within:opacity-100",
        )}
      >
        <span className="bg-border h-px flex-1 opacity-30 transition-opacity group-hover:opacity-100" />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("material.editor.block.addHere")}
          className="text-muted-foreground hover:bg-accent flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs opacity-50 transition-opacity hover:opacity-100"
        >
          <Plus className="size-3 shrink-0" aria-hidden />
          {t("material.editor.block.add")}
        </button>
        <span className="bg-border h-px flex-1 opacity-30 transition-opacity group-hover:opacity-100" />
      </div>
    );
  }

  return (
    <div className="bg-muted/20 flex flex-wrap items-center gap-1.5 rounded-md border p-1.5">
      <Chip onClick={() => choose(newParagraphBlock(t("material.editor.block.newParagraphText")))}>
        <Type className="size-3.5" aria-hidden />
        {t("material.editor.block.type.paragraph")}
      </Chip>
      <Chip onClick={() => choose(newListBlock(t("material.editor.block.newListItemText")))}>
        <List className="size-3.5" aria-hidden />
        {t("material.editor.block.type.list")}
      </Chip>
      <Chip onClick={() => choose(newTableBlock())}>
        <Table className="size-3.5" aria-hidden />
        {t("material.editor.block.type.table")}
      </Chip>
      <Chip
        onClick={() => {
          // A starter timeline carries an unlabelled span and one unlabelled
          // marker — enough to be representable (an empty axis is not; see
          // newTimelineBlock) without inventing student-facing copy in the
          // teacher's own language. The fields below it are where the labels
          // get written.
          const block = newTimelineBlock("", "");
          if (block) choose(block);
        }}
      >
        <GitCommitHorizontal className="size-3.5" aria-hidden />
        {t("material.editor.block.type.timeline")}
      </Chip>
      <Chip onClick={() => choose(newDividerBlock())}>
        <Minus className="size-3.5" aria-hidden />
        {t("material.editor.block.type.divider")}
      </Chip>
      {/* Not a Chip: an image is chosen by uploading one, and the block is
          only inserted once that upload has actually succeeded. */}
      <ImageUploadButton
        label={t("material.editor.block.type.image")}
        onUploaded={(src) => {
          const block = newImageBlock(src, "");
          if (block) choose(block);
        }}
      />
      <Chip onClick={() => setCalloutOpen((v) => !v)}>
        {t("material.editor.block.type.callout")}
        <ChevronRight
          className={cn("size-3.5 transition-transform", calloutOpen && "rotate-90")}
          aria-hidden
        />
      </Chip>
      <button
        type="button"
        onClick={close}
        aria-label={t("common.cancel")}
        className="text-muted-foreground hover:bg-accent ml-auto rounded-full p-1"
      >
        <X className="size-3.5" aria-hidden />
      </button>
      {calloutOpen && (
        <div className="flex w-full flex-wrap gap-1.5 border-t pt-1.5">
          {CALLOUT_VARIANTS.map((variant) => {
            const meta = calloutMeta(variant);
            const Icon = ICONS[meta.icon] ?? Info;
            return (
              <Chip key={variant} onClick={() => choose(newCalloutBlock(variant))}>
                <Icon className="size-3.5" aria-hidden />
                {t(meta.labelKey)}
              </Chip>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-background text-foreground hover:bg-accent inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
    >
      {children}
    </button>
  );
}
