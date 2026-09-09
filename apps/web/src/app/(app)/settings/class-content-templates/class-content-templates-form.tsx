"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Copy, GripVertical, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import { moveArrayItem } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CharacterCounter } from "@/components/ui/character-counter";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError } from "@/components/ui/field-error";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { useLocale, useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import {
  CLASS_CONTENT_MAX_CHARS,
  CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS,
  CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER,
  classContentLength,
} from "@/lib/materials/config";
import {
  duplicateLabel,
  pendingChanges,
  templateExcerpt,
  templateOutline,
  templateRowIssues,
  type EditorRow,
  type TemplateDraft,
  type TemplateRowIssue,
} from "@/lib/materials/template-editor";
import {
  saveClassContentTemplatesAction,
  type SaveTemplatesState,
} from "@/app/actions/class-content";

// The lesson-template manager. The server contract is unchanged and
// deliberately so: the whole list still round-trips through ONE submission,
// array order becomes the new position, and a removed row still posts with
// `keep=0` so the server hard-deletes it. What changed is everything the
// teacher touches.
//
// The page used to render every template as a permanently-open card with a
// ten-row textarea, so a teacher with five templates scrolled past fifty rows
// of Markdown to find the one she wanted, and the page never told her what any
// of them contained without reading it. A lesson template IS its outline, so
// each row now summarises itself with the headings it will impose and opens
// only when she asks for it.
//
// Four real defects went with that shape, fixed here rather than styled over:
//
//   1. `<Label>` carried no `htmlFor` and the fields no `id` — the name and
//      body inputs were unlabelled to a screen reader and unclickable by label.
//   2. `required` sat on the textarea, which UNMOUNTS in preview mode, while
//      the values actually submitted were hidden inputs that validate nothing.
//      A row previewed while empty submitted happily and came back as one
//      server error naming no row. Validation is explicit and per row now,
//      before dispatch (React 19 honours preventDefault in onSubmit), and the
//      submit button is never disabled on validity — it explains instead.
//   3. Removing a template hard-deleted it on the next save with no
//      confirmation and no undo, even though `deleteConfirm` had been sitting
//      in the catalog unused since the manager shipped.
//   4. Nothing said the page had unsaved work. A batch form where one nav click
//      silently discards four rewritten templates has to say so, so the action
//      bar names what is pending and a beforeunload guard backs it.
//
// Reordering follows the house standard set by the focus-tags manager: dnd-kit
// with the KeyboardSensor and live-region announcements, so a keyboard or
// screen-reader user reorders by the same handle a pointer user drags, rather
// than by the single-step chevron pair this page had.

let nextLocalId = 1;
const localId = () => `new-${nextLocalId++}`;

const toRows = (drafts: TemplateDraft[]): EditorRow[] =>
  drafts.map((d) => ({ ...d, keep: true, localKey: d.id }));

// Matches FormStatus's own fade, so the saved confirmation and the bar holding
// it disappear together instead of leaving an empty bar behind.
const SAVED_VISIBLE_MS = 4200;

export function ClassContentTemplatesForm({ initial }: { initial: TemplateDraft[] }) {
  const locale = useLocale();
  const t = useT();

  // `baseline` is the list the server last confirmed; `rows` is what she sees.
  // The difference between the two is the entire unsaved-changes model.
  const [baseline, setBaseline] = useState<TemplateDraft[]>(initial);
  const [rows, setRows] = useState<EditorRow[]>(() => toRows(initial));
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const [previewKeys, setPreviewKeys] = useState<Set<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const [state, formAction, pending] = useActionState<SaveTemplatesState, FormData>(
    saveClassContentTemplatesAction,
    undefined,
  );

  const nameRefs = useRef(new Map<string, HTMLInputElement | null>());
  const bodyRefs = useRef(new Map<string, HTMLTextAreaElement | null>());
  const toggleRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterAdd = useRef<string | null>(null);

  // After a successful save, adopt the server's ids (and drop anything just
  // deleted) so a second save in the same session updates in place — and reset
  // the baseline, so the action bar goes quiet instead of claiming the work is
  // still pending.
  useEffect(() => {
    if (!state?.ok || !state.templates) return;
    setBaseline(state.templates);
    setRows(toRows(state.templates));
    setAttempted(false);
    setJustSaved(true);
    const timer = setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // A newly added row opens focused on its name field: naming it is the first
  // thing she has to do, so the cursor should already be there.
  useEffect(() => {
    const key = focusAfterAdd.current;
    if (!key) return;
    focusAfterAdd.current = null;
    nameRefs.current.get(key)?.focus();
  }, [rows]);

  const visible = useMemo(() => rows.filter((r) => r.keep), [rows]);
  const changes = useMemo(() => pendingChanges(baseline, rows), [baseline, rows]);
  const issues = useMemo(() => templateRowIssues(rows), [rows]);
  const baselineById = useMemo(() => new Map(baseline.map((b) => [b.id, b])), [baseline]);
  const atCap = visible.length >= CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER;

  // Warn on a real unload (reload, close, an external link). Next.js client
  // navigation does not fire this event, so it is a backstop for the losses a
  // browser can still tell us about — not a complete route guard.
  useEffect(() => {
    if (!changes.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changes.dirty]);

  const update = useCallback((localKey: string, patch: Partial<EditorRow>) => {
    setRows((rs) => rs.map((r) => (r.localKey === localKey ? { ...r, ...patch } : r)));
  }, []);

  const setOpen = useCallback((localKey: string, open: boolean) => {
    setOpenKeys((keys) => {
      const next = new Set(keys);
      if (open) next.add(localKey);
      else next.delete(localKey);
      return next;
    });
  }, []);

  function addTemplate(seed: { label: string; body: string }) {
    if (atCap) return;
    const localKey = localId();
    focusAfterAdd.current = localKey;
    setRows((rs) => [...rs, { localKey, id: "", keep: true, ...seed }]);
    setOpen(localKey, true);
  }

  function duplicateRow(row: EditorRow) {
    if (atCap) return;
    const localKey = localId();
    focusAfterAdd.current = localKey;
    const label = duplicateLabel(
      row.label || t("classContentTemplates.editor.newTemplate"),
      visible.map((r) => r.label),
    );
    setRows((rs) => {
      const at = rs.findIndex((r) => r.localKey === row.localKey);
      const copy: EditorRow = { localKey, id: "", label, body: row.body, keep: true };
      return [...rs.slice(0, at + 1), copy, ...rs.slice(at + 1)];
    });
    setOpen(localKey, true);
  }

  // Deleting a row unmounts the button that opened the dialog, so Radix's
  // return-focus lands on a detached node and focus falls to <body>. Put it
  // somewhere deliberate instead: the neighbour that took the row's place, or
  // the add button when the list is now empty. The timeout is what makes this
  // win — it runs after Radix has finished its own (no-op) restore.
  function removeRow(localKey: string) {
    const index = visible.findIndex((r) => r.localKey === localKey);
    const neighbour = visible[index + 1] ?? visible[index - 1];
    update(localKey, { keep: false });
    setOpen(localKey, false);
    setTimeout(() => {
      const target = neighbour ? toggleRefs.current.get(neighbour.localKey) : null;
      (target ?? addButtonRef.current)?.focus();
    }, 0);
  }

  function discard() {
    setRows(toRows(baseline));
    setOpenKeys(new Set());
    setPreviewKeys(new Set());
    setAttempted(false);
  }

  // Reordering only ever permutes the KEPT rows; removed rows keep their slots
  // (they are invisible, and only their `keep=0` payload matters).
  const moveVisible = useCallback((fromIndex: number, toIndex: number) => {
    setRows((prev) => {
      const kept = prev.filter((r) => r.keep);
      if (toIndex < 0 || toIndex >= kept.length) return prev;
      const reordered = moveArrayItem(kept, fromIndex, toIndex);
      let i = 0;
      return prev.map((r) => (r.keep ? reordered[i++] : r));
    });
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rowName = useCallback(
    (row: EditorRow) => row.label.trim() || t("classContentTemplates.editor.newTemplate"),
    [t],
  );

  // Pure lookup, so a drag announcement can describe the position a move WOULD
  // produce without waiting for React state to catch up.
  const describe = useCallback(
    (id: string, list: EditorRow[]) => {
      const index = list.findIndex((r) => r.localKey === id);
      if (index === -1) return null;
      return { name: rowName(list[index]), position: index + 1, total: list.length };
    },
    [rowName],
  );

  const previewMove = useCallback(
    (activeId: string, overId: string): EditorRow[] | null => {
      const from = visible.findIndex((r) => r.localKey === activeId);
      const to = visible.findIndex((r) => r.localKey === overId);
      if (from === -1 || to === -1) return null;
      return moveArrayItem(visible, from, to);
    },
    [visible],
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = visible.findIndex((r) => r.localKey === String(active.id));
    const to = visible.findIndex((r) => r.localKey === String(over.id));
    if (from === -1 || to === -1) return;
    moveVisible(from, to);
  }

  const announcements: Announcements = {
    onDragStart({ active }) {
      const info = describe(String(active.id), visible);
      return info
        ? t("web.settings.classContentTemplates.dragPickedUp", { name: info.name })
        : undefined;
    },
    onDragOver({ active, over }) {
      if (!over) return undefined;
      const next = previewMove(String(active.id), String(over.id));
      const info = next && describe(String(active.id), next);
      return info ? t("web.settings.classContentTemplates.dragMoved", { ...info }) : undefined;
    },
    onDragEnd({ active, over }) {
      const next = over ? previewMove(String(active.id), String(over.id)) : null;
      const info = describe(String(active.id), next ?? visible);
      if (!info) return undefined;
      return next
        ? t("web.settings.classContentTemplates.dragDropped", { ...info })
        : t("web.settings.classContentTemplates.dragCancelled", { name: info.name });
    },
    onDragCancel({ active }) {
      const info = describe(String(active.id), visible);
      return info
        ? t("web.settings.classContentTemplates.dragCancelled", { name: info.name })
        : undefined;
    },
  };

  // Validate before dispatch. React 19 honours preventDefault here, so an
  // invalid list never reaches the action; the offending rows are opened (a
  // collapsed row cannot show its own error) and the first one takes focus.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    setAttempted(true);
    if (issues.size === 0) return;
    e.preventDefault();
    setOpenKeys((keys) => new Set([...keys, ...issues.keys()]));
    const first = visible.find((r) => issues.has(r.localKey));
    if (!first) return;
    const issue = issues.get(first.localKey);
    // Deferred past the render that opens the row — the field does not exist yet.
    requestAnimationFrame(() => {
      const target =
        issue === "name-missing"
          ? nameRefs.current.get(first.localKey)
          : bodyRefs.current.get(first.localKey);
      target?.focus();
    });
  }

  // Posted in visible order first, then the rows removed this session: the
  // server reads `position` from the index among kept rows, so THIS array —
  // not the card markup — is the thing that has to be ordered correctly.
  const posted = useMemo(() => [...visible, ...rows.filter((r) => !r.keep)], [visible, rows]);
  const showErrors = attempted && issues.size > 0;
  const showBar = changes.dirty || pending || justSaved;

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
          {t("web.settings.classContentTemplates.count", { count: visible.length })}
        </p>
        <Button
          type="button"
          ref={addButtonRef}
          variant="outline"
          size="sm"
          onClick={() => addTemplate({ label: "", body: "" })}
          disabled={atCap}
        >
          <Plus className="size-4" aria-hidden />
          {t("classContentTemplates.editor.add")}
        </Button>
      </div>

      {atCap && (
        <p className="text-sm text-muted-foreground">
          {t("web.settings.classContentTemplates.capReached", {
            max: CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER,
          })}
        </p>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title={t("web.settings.classContentTemplates.emptyTitle")}
          description={t("web.settings.classContentTemplates.emptyBody")}
          action={
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <Button
                type="button"
                onClick={() =>
                  addTemplate({
                    label: t("web.settings.classContentTemplates.exampleName"),
                    body: t("classContentTemplates.editor.bodyPlaceholder"),
                  })
                }
              >
                {t("web.settings.classContentTemplates.startFromExample")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => addTemplate({ label: "", body: "" })}
              >
                <Plus className="size-4" aria-hidden />
                {t("classContentTemplates.editor.add")}
              </Button>
            </div>
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable: t("web.settings.classContentTemplates.dragInstructions"),
            },
          }}
        >
          <SortableContext
            items={visible.map((r) => r.localKey)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-3">
              {visible.map((row) => {
                const original = row.id ? baselineById.get(row.id) : undefined;
                return (
                  <TemplateRow
                    key={row.localKey}
                    row={row}
                    name={rowName(row)}
                    status={
                      !row.id
                        ? "new"
                        : original && (original.label !== row.label || original.body !== row.body)
                          ? "edited"
                          : null
                    }
                    open={openKeys.has(row.localKey)}
                    preview={previewKeys.has(row.localKey)}
                    issue={showErrors ? (issues.get(row.localKey) ?? null) : null}
                    locale={locale}
                    t={t}
                    canDuplicate={!atCap}
                    onToggle={(open) => setOpen(row.localKey, open)}
                    onPreview={(on) =>
                      setPreviewKeys((keys) => {
                        const next = new Set(keys);
                        if (on) next.add(row.localKey);
                        else next.delete(row.localKey);
                        return next;
                      })
                    }
                    onChange={(patch) => update(row.localKey, patch)}
                    onDuplicate={() => duplicateRow(row)}
                    onRemove={() => removeRow(row.localKey)}
                    nameRef={(el) => nameRefs.current.set(row.localKey, el)}
                    bodyRef={(el) => bodyRefs.current.set(row.localKey, el)}
                    toggleRef={(el) => toggleRefs.current.set(row.localKey, el)}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {/* The submitted payload, kept as one ordered block rather than scattered
          through the cards: kept rows in their visible order, then the rows
          removed this session (still posted, so the server deletes them). */}
      {posted.map((r) => (
        <div key={`posted-${r.localKey}`} hidden>
          <input type="hidden" name="tpl_id" value={r.id} />
          <input type="hidden" name="tpl_label" value={r.label} />
          <input type="hidden" name="tpl_body" value={r.body} />
          <input type="hidden" name="tpl_keep" value={r.keep ? "1" : "0"} />
        </div>
      ))}

      {showBar && (
        <div
          className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
          role="region"
          aria-label={t("settings.classContentTemplates.title")}
        >
          <div className="min-w-0 space-y-0.5">
            {changes.dirty && (
              <p className="text-sm font-medium">
                {changes.count > 0
                  ? t("web.settings.classContentTemplates.unsaved", { count: changes.count })
                  : t("web.settings.classContentTemplates.unsavedOrder")}
              </p>
            )}
            {showErrors ? (
              <p role="alert" className="text-sm text-destructive">
                {t("web.settings.classContentTemplates.fixErrors")}
              </p>
            ) : (
              <FormStatus
                state={state}
                savedMessage={t("settings.classContentTemplates.saved")}
                pending={pending}
                savingMessage={t("web.settings.bookingPage.saving")}
              />
            )}
          </div>

          {(changes.dirty || pending) && (
            <div className="flex flex-wrap items-center gap-2">
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="ghost" size="sm" disabled={pending}>
                    {t("web.settings.classContentTemplates.discard")}
                  </Button>
                }
                title={t("web.settings.classContentTemplates.discardTitle")}
                description={t("web.settings.classContentTemplates.discardBody")}
                footer={(close) => (
                  <>
                    <Button type="button" variant="outline" onClick={close}>
                      {t("common.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        discard();
                        close();
                      }}
                    >
                      {t("web.settings.classContentTemplates.discard")}
                    </Button>
                  </>
                )}
              />
              <Button type="submit" disabled={pending}>
                {t("settings.classContentTemplates.save")}
              </Button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}

const ISSUE_KEY = {
  "name-missing": "web.settings.classContentTemplates.errorNameMissing",
  "body-missing": "web.settings.classContentTemplates.errorBodyMissing",
  "body-too-long": "web.settings.classContentTemplates.errorBodyTooLong",
} as const;

function TemplateRow({
  row,
  name,
  status,
  open,
  preview,
  issue,
  locale,
  t,
  canDuplicate,
  onToggle,
  onPreview,
  onChange,
  onDuplicate,
  onRemove,
  nameRef,
  bodyRef,
  toggleRef,
}: {
  row: EditorRow;
  name: string;
  status: "new" | "edited" | null;
  open: boolean;
  preview: boolean;
  issue: TemplateRowIssue | null;
  locale: string;
  t: ReturnType<typeof useT>;
  canDuplicate: boolean;
  onToggle: (open: boolean) => void;
  onPreview: (on: boolean) => void;
  onChange: (patch: Partial<EditorRow>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  nameRef: (el: HTMLInputElement | null) => void;
  bodyRef: (el: HTMLTextAreaElement | null) => void;
  toggleRef: (el: HTMLButtonElement | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.localKey,
  });

  const outline = useMemo(() => templateOutline(row.body), [row.body]);
  const excerpt = useMemo(
    () => (outline.length ? "" : templateExcerpt(row.body)),
    [outline, row.body],
  );
  const bodyInvalid = issue === "body-missing" || issue === "body-too-long";

  const panelId = `tpl-panel-${row.localKey}`;
  const nameId = `tpl-name-${row.localKey}`;
  const bodyId = `tpl-body-${row.localKey}`;
  const helpId = `tpl-help-${row.localKey}`;
  const errorId = `tpl-error-${row.localKey}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "relative z-10")}
    >
      <Card
        className={cn(
          "transition-shadow",
          isDragging && "shadow-brand-md",
          issue && "border-destructive",
        )}
      >
        <div className="flex items-center gap-1 p-2 lg:gap-2 lg:px-3">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={t("web.settings.classContentTemplates.dragHandleAria", { name })}
            className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring active:cursor-grabbing lg:size-8"
          >
            <GripVertical className="size-4" aria-hidden />
          </button>

          <button
            type="button"
            ref={toggleRef}
            onClick={() => onToggle(!open)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={t("web.settings.classContentTemplates.rowToggleAria", { name })}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "truncate font-semibold",
                    !row.label.trim() && "font-normal italic text-muted-foreground",
                  )}
                >
                  {name}
                </span>
                {status && (
                  <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground">
                    {status === "new"
                      ? t("web.settings.classContentTemplates.statusNew")
                      : t("web.settings.classContentTemplates.statusEdited")}
                  </span>
                )}
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {outline.length > 0
                  ? outline.slice(0, 5).join(" · ") + (outline.length > 5 ? " …" : "")
                  : excerpt || t("web.settings.classContentTemplates.noSections")}
              </span>
            </span>
            {outline.length > 0 && (
              // Only ever a count of something. At zero the summary line
              // already says "no sections yet", and a "0 sections" chip beside
              // it would be the same fact twice in two different phrasings.
              <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground lg:block">
                {t("web.settings.classContentTemplates.sections", { count: outline.length })}
              </span>
            )}
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        </div>

        <div id={panelId} hidden={!open} className="space-y-4 border-t px-4 py-4 lg:px-5">
          <div className="space-y-2">
            <Label htmlFor={nameId}>{t("classContentTemplates.editor.name")}</Label>
            <Input
              id={nameId}
              ref={nameRef}
              value={row.label}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder={t("classContentTemplates.editor.namePlaceholder")}
              maxLength={CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS}
              invalid={issue === "name-missing"}
              aria-describedby={issue === "name-missing" ? errorId : undefined}
            />
            {issue === "name-missing" && <FieldError id={errorId} message={t(ISSUE_KEY[issue])} />}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={bodyId}>{t("classContentTemplates.editor.body")}</Label>
              {/* A two-state toggle, not a tablist: there is one panel and the
                  buttons swap what fills it, so `aria-pressed` describes it
                  honestly where tab semantics would promise a second panel. */}
              <div
                role="group"
                aria-label={t("classContentTemplates.editor.body")}
                className="inline-flex items-center gap-1 rounded-md bg-muted p-1"
              >
                <ModeButton pressed={!preview} onClick={() => onPreview(false)}>
                  {t("web.settings.classContentTemplates.write")}
                </ModeButton>
                <ModeButton pressed={preview} onClick={() => onPreview(true)}>
                  {t("web.settings.classContentTemplates.preview")}
                </ModeButton>
              </div>
            </div>

            {preview ? (
              <div className="min-h-48 rounded-md border bg-muted/30 px-4 py-3">
                {row.body.trim() ? (
                  <ClassContentMarkdown body={row.body} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("web.settings.classContentTemplates.noPreview")}
                  </p>
                )}
              </div>
            ) : (
              <Textarea
                id={bodyId}
                ref={bodyRef}
                value={row.body}
                onChange={(e) => onChange({ body: e.target.value })}
                rows={12}
                spellCheck={false}
                className="min-h-48 font-mono text-sm leading-relaxed"
                placeholder={t("classContentTemplates.editor.bodyPlaceholder")}
                invalid={bodyInvalid}
                aria-describedby={bodyInvalid ? `${errorId} ${helpId}` : helpId}
              />
            )}

            <div className="flex flex-wrap items-start justify-between gap-2">
              <p id={helpId} className="max-w-prose text-xs text-muted-foreground">
                {t("web.settings.classContentTemplates.bodyHelp")}
              </p>
              <CharacterCounter
                length={classContentLength(row.body)}
                max={CLASS_CONTENT_MAX_CHARS}
              />
            </div>
            {bodyInvalid && (
              <FieldError
                id={errorId}
                message={t(ISSUE_KEY[issue], {
                  max: CLASS_CONTENT_MAX_CHARS.toLocaleString(locale),
                })}
              />
            )}
          </div>

          {outline.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("web.settings.classContentTemplates.outlineLabel")}
              </p>
              <ol className="flex flex-wrap gap-1.5">
                {outline.map((heading, i) => (
                  <li
                    key={`${heading}-${i}`}
                    className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {heading}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDuplicate}
              disabled={!canDuplicate}
              aria-label={t("web.settings.classContentTemplates.duplicateAria", { name })}
            >
              <Copy className="size-4" aria-hidden />
              {t("web.settings.classContentTemplates.duplicate")}
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  aria-label={t("web.settings.classContentTemplates.removeAria", { name })}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t("common.delete")}
                </Button>
              }
              title={t("classContentTemplates.editor.deleteConfirm")}
              description={t("web.settings.classContentTemplates.deleteBody")}
              footer={(close) => (
                <>
                  <Button type="button" variant="outline" onClick={close}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      close();
                      onRemove();
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </>
              )}
            />
          </div>
        </div>
      </Card>
    </li>
  );
}

function ModeButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
        pressed
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
