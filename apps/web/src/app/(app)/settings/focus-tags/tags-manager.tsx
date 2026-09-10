"use client";

import { useCallback, useId, useMemo, useRef, useState, type RefObject } from "react";
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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Search,
  Tags,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { moveArrayItem, moveWithinGroup, reassignItemGroup } from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CharacterCounter } from "@/components/ui/character-counter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";
import {
  FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS,
  FOCUS_TAG_LABEL_MAX_CHARS,
  FOCUS_TAG_SEARCH_THRESHOLD,
  filterFocusGroups,
  isDuplicateFocusLabel,
} from "@/lib/focus-tag-editing";
import { saveFocusCategoriesAction, saveFocusTagsAction } from "@/app/actions/focus-tags";

// Grouped, autosaving manager for the teacher's focus taxonomy. It replaced a
// pair of flat forms whose every tag row repeated its own category name in a
// <Select> — a category with 10 tags printed its name 10 times, each row eating
// the full content column. A category is a section shown ONCE here, with its
// tags as wrapping chips underneath, and every add/rename/move/delete saves
// immediately against the same saveFocusTagsAction/saveFocusCategoriesAction
// server actions (plain "use server" functions, callable outside a <form>), so
// the Pro gate, validation and replace-set semantics are unchanged.
//
// WHAT THE CURRENT PASS CHANGED, and why each one was a defect rather than a
// preference:
//
//   * HIERARCHY WAS INVERTED. A category rendered as muted 15px semibold text
//     while its tags sat inside bordered chips — the group label was the
//     quietest thing in its own group. A category is now a Card with a real
//     <h2> (the section is named BY that heading via aria-labelledby, not by a
//     duplicate aria-label that can drift from it) and a count beside it.
//
//   * ESCAPE SAVED. `onOpenChange(false)` committed the dialog, so dismissing
//     it — escape, the X, a click outside — applied the edit. Every one of
//     those gestures means "discard" in every other dialog in the app and in
//     the platform. Closing now discards; Save is the only commit.
//
//   * REORDERING FROM THE DIALOG WAS NOT STAGED. Move up/down/top/bottom wrote
//     through immediately while the name field waited for Save, so one dialog
//     had two different commit rules. Position is dialog state now, applied
//     with everything else, and the dialog reads back "Position 3 of 12" so the
//     buttons have visible feedback behind the overlay.
//
//   * DELETE WAS ONE CLICK AND FINAL. It now confirms in place, and — because
//     the server ARCHIVES rather than drops, and re-submitting a kept row by id
//     sets `archived: false` again — the undo re-persists the pre-delete array
//     and restores the same row, with its material links and its old position
//     intact. That is a real undo, not a re-create wearing the same name.
//
//   * THERE WAS NO WAY TO FIND A TAG. The ceiling is 300 tags across 60
//     categories and a seeded pack alone is 30-40, all rendered at once. Search
//     filters tags and categories together; reordering pauses while it is on,
//     because dragging item 3 of a filtered list has no meaning in the full one.
//
//   * THE SAVE LINE MOVED THE PAGE. "Saving…" mounted and unmounted, shifting
//     everything under it on every keystroke's worth of autosave. It is a fixed
//     slot that reads Saving… then Saved, and both states carry a word rather
//     than a colour (D-140).
//
// Reordering has two independent mechanisms, deliberately, so neither is a
// single point of failure:
//   1. Drag-and-drop (dnd-kit) for direct manipulation, with dnd-kit's
//      KeyboardSensor making the same handles operable from the keyboard (Tab
//      to focus, Space/Enter to pick up, arrows to move, Escape to cancel) and
//      live-region announcements so a screen-reader user gets what a sighted
//      drag gives. Handles appear only under `desktop:` — `(min-width: 1024px)
//      and (pointer: fine)` — because a 12px grip inside a chip is not a touch
//      target, and D-140 puts the floor at 44px. A finger reorders through (2).
//      Categories reorder among themselves; a tag reorders within its OWN
//      category, since moving one to a DIFFERENT category is a deliberate act
//      through the dialog's picker rather than an imprecise cross-page drag.
//   2. Move to top / up / down / to bottom in the edit dialog — an O(1) jump
//      for the large-list case drag alone handles badly, available to every
//      input device, and the only one that works while a search is active.

type CategoryRow = { id: string; label: string };
type TagRow = { id: string; label: string; categoryId: string };

let nextLocalId = 1;
const localId = (prefix: string) => `local-${prefix}-${nextLocalId++}`;
const isLocal = (id: string) => id.startsWith("local-");

type SubmitResult<Row> = { ok: true; rows: Row[] } | { ok: false; message: string };

// Replace-set autosave: `persist(next)` is the whole new visible array (add =
// append, rename/move-category = map, delete = filter, reorder = re-sort) —
// mirrors the server's replace-set contract, so every mutation is expressed
// the same way. Saves are serialized (a second `persist` while one is
// in-flight queues behind it, and only the LATEST desired state is ever sent)
// so rapid edits can't race each other out of order. On failure the row set
// reverts to the last server-confirmed state — an optimistic edit that got
// rejected (not Pro, category still in use, etc.) doesn't linger on screen.
function useReplaceSetAutosave<Row extends { id: string }>(
  initial: Row[],
  submit: (current: Row[], removed: Row[]) => Promise<SubmitResult<Row>>,
) {
  const [rows, setRows] = useState(initial);
  const [saving, setSaving] = useState(false);
  // Whether anything has been saved yet this visit — the difference between
  // "nothing to say" on first paint and a standing "Saved" once there is.
  const [everSaved, setEverSaved] = useState(false);
  const lastGoodRef = useRef(initial);
  const pendingRef = useRef<Row[] | null>(null);
  const runningRef = useRef(false);
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const runQueue = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setSaving(true);
    void (async () => {
      while (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        const nextIds = new Set(next.map((r) => r.id));
        const removed = lastGoodRef.current.filter((r) => !nextIds.has(r.id) && !isLocal(r.id));
        const result = await submitRef.current(next, removed);
        if (result.ok) {
          lastGoodRef.current = result.rows;
          setRows(result.rows);
          setEverSaved(true);
        } else {
          toast.error(result.message);
          setRows(lastGoodRef.current);
        }
      }
      runningRef.current = false;
      setSaving(false);
    })();
  }, []);

  const persist = useCallback(
    (next: Row[]) => {
      setRows(next);
      pendingRef.current = next;
      runQueue();
    },
    [runQueue],
  );

  return { rows, persist, saving, everSaved } as const;
}

function categoriesFormData(current: CategoryRow[], removed: CategoryRow[]): FormData {
  const fd = new FormData();
  const push = (r: CategoryRow, keep: boolean) => {
    fd.append("category_id", isLocal(r.id) ? "" : r.id);
    fd.append("category_label", r.label);
    fd.append("category_keep", keep ? "1" : "0");
  };
  current.forEach((r) => push(r, true));
  removed.forEach((r) => push(r, false));
  return fd;
}

async function submitCategories(
  current: CategoryRow[],
  removed: CategoryRow[],
): Promise<SubmitResult<CategoryRow>> {
  const result = await saveFocusCategoriesAction(undefined, categoriesFormData(current, removed));
  if (!result?.ok || !result.categories) {
    return { ok: false, message: result?.error ?? "Error" };
  }
  return { ok: true, rows: result.categories.map((c) => ({ id: c.id, label: c.label })) };
}

function tagsFormData(current: TagRow[], removed: TagRow[]): FormData {
  const fd = new FormData();
  const push = (r: TagRow, keep: boolean) => {
    fd.append("tag_id", isLocal(r.id) ? "" : r.id);
    fd.append("tag_label", r.label);
    fd.append("tag_category_id", r.categoryId);
    fd.append("tag_keep", keep ? "1" : "0");
  };
  current.forEach((r) => push(r, true));
  removed.forEach((r) => push(r, false));
  return fd;
}

async function submitTags(current: TagRow[], removed: TagRow[]): Promise<SubmitResult<TagRow>> {
  const result = await saveFocusTagsAction(undefined, tagsFormData(current, removed));
  if (!result?.ok || !result.tags) {
    return { ok: false, message: result?.error ?? "Error" };
  }
  return {
    ok: true,
    rows: result.tags.map((t) => ({ id: t.id, label: t.label, categoryId: t.categoryId })),
  };
}

// `position` is the row's index within its own list — the categories array for
// a category, the tags of one category for a tag — held as dialog state so the
// move buttons commit with Save like every other field, rather than writing
// through behind the overlay. `null` on a tag means "append to the end of the
// target category", which is what a fresh tag and a reassigned one both want.
type CategoryDialogState =
  { mode: "create"; label: string } | { mode: "edit"; id: string; label: string; position: number };
type TagDialogState =
  | { mode: "create"; label: string; categoryId: string }
  | {
      mode: "edit";
      id: string;
      label: string;
      categoryId: string;
      originalCategoryId: string;
      position: number | null;
    };

// Resolves a dragged row's id (category or tag) to its label and its
// 1-based position within its own list, for both the applied move and the
// screen-reader announcement — a pure lookup so it can be called against
// either the current or the just-computed "next" arrays without depending on
// React state having re-rendered yet.
function describeRow(
  id: string,
  categoryRows: CategoryRow[],
  tagRows: TagRow[],
): { label: string; position: number; total: number } | null {
  const categoryIndex = categoryRows.findIndex((c) => c.id === id);
  if (categoryIndex !== -1) {
    return {
      label: categoryRows[categoryIndex].label,
      position: categoryIndex + 1,
      total: categoryRows.length,
    };
  }
  const tag = tagRows.find((t) => t.id === id);
  if (tag) {
    const group = tagRows.filter((t) => t.categoryId === tag.categoryId);
    return {
      label: tag.label,
      position: group.findIndex((t) => t.id === id) + 1,
      total: group.length,
    };
  }
  return null;
}

export function TagsManager({
  initialCategories,
  initialTags,
}: {
  initialCategories: CategoryRow[];
  initialTags: TagRow[];
}) {
  const t = useT();
  const categories = useReplaceSetAutosave(initialCategories, submitCategories);
  const tags = useReplaceSetAutosave(initialTags, submitTags);

  const [query, setQuery] = useState("");
  const [categoryDialog, setCategoryDialog] = useState<CategoryDialogState | null>(null);
  const [tagDialog, setTagDialog] = useState<TagDialogState | null>(null);
  // One flag rather than one per dialog: only one dialog is ever open, and it
  // is cleared on every open and close so a confirm can't survive into the
  // next thing the teacher edits.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const categoryNameRef = useRef<HTMLInputElement>(null);
  const tagNameRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  const groups = useMemo(
    () =>
      categories.rows.map((category) => ({
        category,
        tags: tags.rows.filter((tag) => tag.categoryId === category.id),
      })),
    [categories.rows, tags.rows],
  );
  const assignableCategories = useMemo(
    () => categories.rows.filter((c) => !isLocal(c.id)),
    [categories.rows],
  );

  const searching = query.trim().length > 0;
  // Once the field is on screen it stays, even if a delete drops the count back
  // under the threshold mid-search — a search box that vanishes while its own
  // query is still filtering the page is worse than one row of chrome.
  const showSearch = searching || tags.rows.length >= FOCUS_TAG_SEARCH_THRESHOLD;
  const { groups: visibleGroups, matches } = useMemo(
    () => filterFocusGroups(groups, query),
    [groups, query],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Applies a single drag move and returns the resulting {categories, tags}
  // pair (only one of the two actually changes). Pure — used both to commit
  // the move and, independently, to phrase the drop announcement — so the
  // announcement never depends on React state having caught up yet.
  const applyDrag = useCallback(
    (activeId: string, overId: string): { categories: CategoryRow[]; tags: TagRow[] } | null => {
      const categoryIndex = categories.rows.findIndex((c) => c.id === activeId);
      if (categoryIndex !== -1) {
        const overIndex = categories.rows.findIndex((c) => c.id === overId);
        if (overIndex === -1) return null;
        return {
          categories: moveArrayItem(categories.rows, categoryIndex, overIndex),
          tags: tags.rows,
        };
      }
      const activeTag = tags.rows.find((r) => r.id === activeId);
      if (!activeTag) return null;
      const group = tags.rows.filter((r) => r.categoryId === activeTag.categoryId);
      const overIndexInGroup = group.findIndex((r) => r.id === overId);
      if (overIndexInGroup === -1) return null;
      return {
        categories: categories.rows,
        tags: moveWithinGroup(tags.rows, (r) => r.categoryId, activeId, overIndexInGroup),
      };
    },
    [categories.rows, tags.rows],
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = applyDrag(String(active.id), String(over.id));
    if (!next) return;
    if (next.categories !== categories.rows) categories.persist(next.categories);
    if (next.tags !== tags.rows) tags.persist(next.tags);
  }

  const announcements: Announcements = {
    onDragStart({ active }) {
      const info = describeRow(String(active.id), categories.rows, tags.rows);
      return info ? t("focusTags.manager.dragPickedUp", { name: info.label }) : undefined;
    },
    onDragOver({ active, over }) {
      if (!over || active.id === over.id) return undefined;
      const next = applyDrag(String(active.id), String(over.id));
      if (!next) return undefined;
      const info = describeRow(String(active.id), next.categories, next.tags);
      return info
        ? t("focusTags.manager.dragMoved", {
            name: info.label,
            position: info.position,
            total: info.total,
          })
        : undefined;
    },
    onDragEnd({ active, over }) {
      if (!over) {
        const info = describeRow(String(active.id), categories.rows, tags.rows);
        return info ? t("focusTags.manager.dragCancelled", { name: info.label }) : undefined;
      }
      const next = applyDrag(String(active.id), String(over.id));
      if (!next) return undefined;
      const info = describeRow(String(active.id), next.categories, next.tags);
      return info
        ? t("focusTags.manager.dragDropped", {
            name: info.label,
            position: info.position,
            total: info.total,
          })
        : undefined;
    },
    onDragCancel({ active }) {
      const info = describeRow(String(active.id), categories.rows, tags.rows);
      return info ? t("focusTags.manager.dragCancelled", { name: info.label }) : undefined;
    },
  };

  // ---- dialogs ----

  function openCategoryDialog(next: CategoryDialogState | null) {
    setConfirmingDelete(false);
    setCategoryDialog(next);
  }

  function openTagDialog(next: TagDialogState | null) {
    setConfirmingDelete(false);
    setTagDialog(next);
  }

  // ---- categories ----

  function saveCategoryDialog() {
    const state = categoryDialog;
    if (!state) return;
    const label = state.label.trim();
    if (!label) return;

    if (state.mode === "create") {
      categories.persist([...categories.rows, { id: localId("cat"), label }]);
      openCategoryDialog(null);
      return;
    }

    const index = categories.rows.findIndex((c) => c.id === state.id);
    if (index === -1) {
      openCategoryDialog(null);
      return;
    }
    let next = categories.rows;
    if (label !== categories.rows[index].label) {
      next = next.map((c) => (c.id === state.id ? { ...c, label } : c));
    }
    if (state.position !== index) next = moveArrayItem(next, index, state.position);
    if (next !== categories.rows) categories.persist(next);
    openCategoryDialog(null);
  }

  function deleteCategory(id: string) {
    const before = categories.rows;
    const row = before.find((c) => c.id === id);
    if (!row) return;
    openCategoryDialog(null);
    categories.persist(before.filter((c) => c.id !== id));
    offerUndo(row.label, () => categories.persist(before));
  }

  // ---- tags ----

  function saveTagDialog() {
    const state = tagDialog;
    if (!state) return;
    const label = state.label.trim();
    if (!label) return;

    if (state.mode === "create") {
      tags.persist([...tags.rows, { id: localId("tag"), label, categoryId: state.categoryId }]);
      openTagDialog(null);
      return;
    }

    const original = tags.rows.find((r) => r.id === state.id);
    if (!original) {
      openTagDialog(null);
      return;
    }

    let next =
      label !== original.label
        ? tags.rows.map((r) => (r.id === state.id ? { ...r, label } : r))
        : tags.rows;

    if (state.categoryId !== original.categoryId) {
      // Reassigning appends the tag to the END of the target category, like a
      // freshly-created one, rather than leaving it at its old array slot —
      // which could otherwise land it anywhere in the new category depending
      // on incidental prior ordering.
      next = reassignItemGroup(next, state.id, state.categoryId, (row, categoryId) => ({
        ...row,
        categoryId,
      }));
    } else if (state.position !== null) {
      next = moveWithinGroup(next, (r) => r.categoryId, state.id, state.position);
    }

    if (next !== tags.rows) tags.persist(next);
    openTagDialog(null);
  }

  function deleteTag(id: string) {
    const before = tags.rows;
    const row = before.find((r) => r.id === id);
    if (!row) return;
    openTagDialog(null);
    tags.persist(before.filter((r) => r.id !== id));
    offerUndo(row.label, () => tags.persist(before));
  }

  // The delete is optimistic and the row is only ARCHIVED server-side, so
  // re-persisting the pre-delete array restores the same row by id — same
  // material links, same slot in the order. This is the whole reason delete can
  // stay one confirm rather than a modal interrogation.
  function offerUndo(name: string, restore: () => void) {
    toast.success(t("focusTags.manager.deleted", { name }), {
      action: {
        label: t("focusTags.manager.undo"),
        onClick: () => {
          restore();
          toast.success(t("focusTags.manager.restored", { name }));
        },
      },
    });
  }

  // Archiving a category that still holds tags is refused server-side (and by
  // `onDelete: Restrict` under it). Saying so before the click is the whole
  // difference between a rule and an error message.
  function blockedCategoryDeleteReason(categoryId: string): string | null {
    const count = tags.rows.filter((r) => r.categoryId === categoryId).length;
    return count > 0 ? t("focusTags.manager.categoryHasTags", { count }) : null;
  }

  const saving = categories.saving || tags.saving;
  const everSaved = categories.everSaved || tags.everSaved;

  // With nothing on the page yet, the toolbar is three controls describing
  // nothing: a search over zero tags, "0 tags · 0 categories", and a second
  // Add category beside the empty state's own. The empty state IS the toolbar
  // at that point.
  const hasCategories = categories.rows.length > 0;

  return (
    <div className="space-y-5">
      {hasCategories && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {showSearch && (
              <div role="search" className="relative min-w-0 flex-1 basis-56">
                <Label htmlFor={searchId} className="sr-only">
                  {t("focusTags.manager.searchLabel")}
                </Label>
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id={searchId}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query) {
                      e.preventDefault();
                      setQuery("");
                    }
                  }}
                  placeholder={t("focusTags.manager.searchPlaceholder")}
                  autoComplete="off"
                  className="pr-10 pl-9"
                />
                {searching && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setQuery("")}
                    aria-label={t("focusTags.manager.searchClear")}
                    // Below the 44px floor deliberately, and the one place in
                    // this file that is: the button sits INSIDE a 44px field, so
                    // a full-size target would cover the text it clears, and the
                    // field's own padding gives it that much slop anyway.
                    // Escape in the field does the same thing for a keyboard.
                    className="absolute top-1/2 right-1 h-9 w-9 -translate-y-1/2 rounded-full lg:h-9 lg:w-9"
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => openCategoryDialog({ mode: "create", label: "" })}
              className="w-full lg:ml-auto lg:w-auto"
            >
              <Plus className="size-4" aria-hidden />
              {t("focusTags.categoryEditor.add")}
            </Button>
          </div>

          <div
            role="status"
            aria-live="polite"
            className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
          >
            {searching ? (
              <span>{t("focusTags.manager.searchMatches", { count: matches })}</span>
            ) : (
              <>
                <span>{t("focusTags.manager.tagCount", { count: tags.rows.length })}</span>
                <span aria-hidden>·</span>
                <span>
                  {t("focusTags.manager.categoryCount", { count: categories.rows.length })}
                </span>
              </>
            )}
            {saving ? (
              <span className="flex items-center gap-1.5">
                <span aria-hidden>·</span>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t("web.settings.bookingPage.saving")}
              </span>
            ) : everSaved ? (
              <span className="flex items-center gap-1.5 text-success">
                <span className="text-muted-foreground" aria-hidden>
                  ·
                </span>
                <Check className="size-3.5" aria-hidden />
                {t("focusTags.manager.saved")}
              </span>
            ) : null}
          </div>

          {searching && visibleGroups.length > 0 && (
            <p className="text-sm text-subtle">{t("focusTags.manager.searchReorderPaused")}</p>
          )}
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t("focusTags.manager.dragInstructions") },
        }}
      >
        <SortableContext
          items={categories.rows.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {visibleGroups.map((group) => (
              <CategoryCard
                key={group.category.id}
                category={group.category}
                tags={group.tags}
                t={t}
                filtering={searching}
                onEdit={() =>
                  openCategoryDialog({
                    mode: "edit",
                    id: group.category.id,
                    label: group.category.label,
                    position: categories.rows.findIndex((c) => c.id === group.category.id),
                  })
                }
                onAddTag={() =>
                  openTagDialog({ mode: "create", label: "", categoryId: group.category.id })
                }
                onEditTag={(tag) => {
                  const siblings = tags.rows.filter((r) => r.categoryId === tag.categoryId);
                  openTagDialog({
                    mode: "edit",
                    id: tag.id,
                    label: tag.label,
                    categoryId: tag.categoryId,
                    originalCategoryId: tag.categoryId,
                    position: siblings.findIndex((r) => r.id === tag.id),
                  });
                }}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {visibleGroups.length === 0 &&
        (searching ? (
          <EmptyState
            icon={Search}
            title={t("focusTags.manager.searchEmptyTitle")}
            description={t("focusTags.manager.searchEmptyBody")}
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => setQuery("")}>
                {t("focusTags.manager.searchClear")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Tags}
            title={t("focusTags.manager.emptyTitle")}
            description={t("focusTags.manager.emptyBody")}
            action={
              <Button
                type="button"
                onClick={() => openCategoryDialog({ mode: "create", label: "" })}
              >
                <Plus className="size-4" aria-hidden />
                {t("focusTags.categoryEditor.add")}
              </Button>
            }
          />
        ))}

      {/* Category create/edit dialog */}
      <Dialog
        open={categoryDialog !== null}
        onOpenChange={(open) => {
          if (!open) openCategoryDialog(null);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            categoryNameRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {categoryDialog?.mode === "create"
                ? t("focusTags.manager.newCategoryTitle")
                : t("focusTags.manager.editCategoryTitle")}
            </DialogTitle>
            <DialogDescription>{t("settings.focusTags.categoriesHelp")}</DialogDescription>
          </DialogHeader>

          {categoryDialog && (
            <div className="space-y-4">
              <NameField
                id="category-name"
                inputRef={categoryNameRef}
                label={t("web.settings.focusTags.categoryNameLabel")}
                placeholder={t("focusTags.categoryEditor.namePlaceholder")}
                max={FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS}
                value={categoryDialog.label}
                onChange={(label) => setCategoryDialog({ ...categoryDialog, label })}
                onSubmit={saveCategoryDialog}
                duplicateHint={
                  isDuplicateFocusLabel(
                    categoryDialog.label,
                    categories.rows,
                    categoryDialog.mode === "edit" ? categoryDialog.id : undefined,
                  )
                    ? t("focusTags.manager.duplicateCategory")
                    : null
                }
                t={t}
              />

              {categoryDialog.mode === "edit" && (
                <ReorderControls
                  t={t}
                  position={categoryDialog.position}
                  total={categories.rows.length}
                  onMove={(position) => setCategoryDialog({ ...categoryDialog, position })}
                />
              )}
            </div>
          )}

          <DialogActions
            t={t}
            deletable={categoryDialog?.mode === "edit"}
            confirming={confirmingDelete}
            onStartDelete={() => setConfirmingDelete(true)}
            onCancelDelete={() => setConfirmingDelete(false)}
            onDelete={() => categoryDialog?.mode === "edit" && deleteCategory(categoryDialog.id)}
            deletePrompt={t("focusTags.manager.deleteCategoryPrompt")}
            deleteBlockedReason={
              categoryDialog?.mode === "edit"
                ? blockedCategoryDeleteReason(categoryDialog.id)
                : null
            }
            onCancel={() => openCategoryDialog(null)}
            onSave={saveCategoryDialog}
            canSave={Boolean(categoryDialog?.label.trim())}
          />
        </DialogContent>
      </Dialog>

      {/* Tag create/edit dialog */}
      <Dialog
        open={tagDialog !== null}
        onOpenChange={(open) => {
          if (!open) openTagDialog(null);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            tagNameRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {tagDialog?.mode === "create"
                ? t("focusTags.manager.newTagTitle")
                : t("focusTags.manager.editTagTitle")}
            </DialogTitle>
          </DialogHeader>

          {tagDialog && (
            <div className="space-y-4">
              <NameField
                id="tag-name"
                inputRef={tagNameRef}
                label={t("focusTags.editor.name")}
                placeholder={t("focusTags.editor.namePlaceholder")}
                max={FOCUS_TAG_LABEL_MAX_CHARS}
                value={tagDialog.label}
                onChange={(label) => setTagDialog({ ...tagDialog, label })}
                onSubmit={saveTagDialog}
                duplicateHint={
                  isDuplicateFocusLabel(
                    tagDialog.label,
                    tags.rows.filter((r) => r.categoryId === tagDialog.categoryId),
                    tagDialog.mode === "edit" ? tagDialog.id : undefined,
                  )
                    ? t("focusTags.manager.duplicateTag")
                    : null
                }
                t={t}
              />

              <div className="space-y-2">
                <Label htmlFor="tag-category">{t("focusTags.editor.category")}</Label>
                <Select
                  value={tagDialog.categoryId}
                  onValueChange={(categoryId) =>
                    setTagDialog(
                      tagDialog.mode === "edit"
                        ? {
                            ...tagDialog,
                            categoryId,
                            // Back on the original category, the staged
                            // position means something again; anywhere else the
                            // tag appends, so there is no slot to hold.
                            position:
                              categoryId === tagDialog.originalCategoryId
                                ? tagDialog.position
                                : null,
                          }
                        : { ...tagDialog, categoryId },
                    )
                  }
                >
                  <SelectTrigger id="tag-category">
                    <SelectValue placeholder={t("focusTags.editor.categorySelectPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableCategories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {tagDialog.mode === "edit" && tagDialog.position !== null && (
                <ReorderControls
                  t={t}
                  position={tagDialog.position}
                  total={tags.rows.filter((r) => r.categoryId === tagDialog.categoryId).length || 1}
                  onMove={(position) => setTagDialog({ ...tagDialog, position })}
                />
              )}
            </div>
          )}

          <DialogActions
            t={t}
            deletable={tagDialog?.mode === "edit"}
            confirming={confirmingDelete}
            onStartDelete={() => setConfirmingDelete(true)}
            onCancelDelete={() => setConfirmingDelete(false)}
            onDelete={() => tagDialog?.mode === "edit" && deleteTag(tagDialog.id)}
            deletePrompt={t("focusTags.manager.deleteTagPrompt")}
            deleteBlockedReason={null}
            onCancel={() => openTagDialog(null)}
            onSave={saveTagDialog}
            canSave={Boolean(tagDialog?.label.trim())}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// The name input, its counter and its two hints, shared by both dialogs
// because "a required name, capped, warned about when it duplicates a sibling"
// is one control rather than two that happen to look alike.
function NameField({
  id,
  inputRef,
  label,
  placeholder,
  max,
  value,
  onChange,
  onSubmit,
  duplicateHint,
  t,
}: {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  placeholder: string;
  max: number;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  duplicateHint: string | null;
  t: ReturnType<typeof useT>;
}) {
  const hintId = `${id}-hint`;
  const empty = value.trim().length === 0;
  const hint = empty ? t("focusTags.manager.nameRequired") : duplicateHint;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        maxLength={max}
        autoComplete="off"
        aria-describedby={hint ? hintId : undefined}
      />
      <div className="flex items-start justify-between gap-3">
        <p id={hintId} className={cn("text-sm", hint ? "text-subtle" : "sr-only")}>
          {hint}
        </p>
        <CharacterCounter length={value.length} max={max} className="ml-auto shrink-0" />
      </div>
    </div>
  );
}

// Move to top / up / down / to bottom, plus the position they produce. The
// readout is what makes the buttons usable from inside a dialog: the list they
// reorder is behind the overlay, so without it the teacher is pressing a button
// with no feedback at all.
function ReorderControls({
  t,
  position,
  total,
  onMove,
}: {
  t: ReturnType<typeof useT>;
  position: number;
  total: number;
  onMove: (position: number) => void;
}) {
  const atStart = position <= 0;
  const atEnd = position >= total - 1;

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{t("focusTags.manager.reorderLegend")}</p>
        <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
          {t("focusTags.manager.position", { position: position + 1, total })}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atStart}
          onClick={() => onMove(0)}
        >
          <ChevronsUp className="size-4" aria-hidden />
          {t("focusTags.editor.moveToTop")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atStart}
          onClick={() => onMove(position - 1)}
        >
          <ChevronUp className="size-4" aria-hidden />
          {t("focusTags.editor.moveUp")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atEnd}
          onClick={() => onMove(position + 1)}
        >
          <ChevronDown className="size-4" aria-hidden />
          {t("focusTags.editor.moveDown")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atEnd}
          onClick={() => onMove(total - 1)}
        >
          <ChevronsDown className="size-4" aria-hidden />
          {t("focusTags.editor.moveToBottom")}
        </Button>
      </div>
    </div>
  );
}

// The whole dialog footer, for both dialogs — identical by construction rather
// than by two copies that agree today.
//
// Confirming a delete REPLACES the footer instead of adding a row to it. A
// stacked alert dialog would trap focus twice and bury the thing being deleted
// under two overlays; a confirm button sitting beside a still-live Save asks
// two questions at once. In the confirm state there is exactly one question and
// two answers.
function DialogActions({
  t,
  deletable,
  confirming,
  onStartDelete,
  onCancelDelete,
  onDelete,
  deletePrompt,
  deleteBlockedReason,
  onCancel,
  onSave,
  canSave,
}: {
  t: ReturnType<typeof useT>;
  deletable: boolean;
  confirming: boolean;
  onStartDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  deletePrompt: string;
  /** Non-null when the row cannot be deleted yet, and why. */
  deleteBlockedReason: string | null;
  onCancel: () => void;
  onSave: () => void;
  canSave: boolean;
}) {
  if (confirming) {
    return (
      <DialogFooter className="flex-col gap-3 lg:flex-col">
        <p className="w-full max-w-prose text-sm text-subtle">{deletePrompt}</p>
        <div className="flex w-full flex-col-reverse gap-2 lg:flex-row lg:justify-end">
          <Button type="button" variant="ghost" onClick={onCancelDelete}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onDelete}>
            {t("focusTags.manager.deleteConfirm")}
          </Button>
        </div>
      </DialogFooter>
    );
  }

  return (
    <DialogFooter className="lg:justify-between">
      {deletable && deleteBlockedReason ? (
        <p className="max-w-prose text-sm text-subtle">{deleteBlockedReason}</p>
      ) : deletable ? (
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onStartDelete}
        >
          {t("common.delete")}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-col-reverse gap-2 lg:flex-row">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" onClick={onSave} disabled={!canSave}>
          {t("common.save")}
        </Button>
      </div>
    </DialogFooter>
  );
}

function CategoryCard({
  category,
  tags,
  t,
  filtering,
  onEdit,
  onAddTag,
  onEditTag,
}: {
  category: CategoryRow;
  tags: TagRow[];
  t: ReturnType<typeof useT>;
  filtering: boolean;
  onEdit: () => void;
  onAddTag: () => void;
  onEditTag: (tag: TagRow) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: category.id,
    disabled: filtering,
  });
  const headingId = `focus-category-${category.id}`;
  // A category that has not come back from the server yet has no real id, so
  // nothing can be filed under it — the tag save would be rejected for an
  // unknown category. It resolves in a round trip; say so rather than showing a
  // dead control.
  const pending = isLocal(category.id);

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      aria-labelledby={headingId}
      className={cn("relative", isDragging && "z-10")}
    >
      <Card className={cn("transition-shadow", isDragging && "shadow-brand-lg")}>
        <CardHeader className="flex-row items-center gap-2 space-y-0 p-4 pb-2.5">
          {!filtering && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={t("focusTags.manager.dragHandleAria", { name: category.label })}
              className="hidden shrink-0 cursor-grab touch-none rounded-md p-1 text-subtle ring-offset-background transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden active:cursor-grabbing desktop:block"
            >
              <GripVertical className="size-4" aria-hidden />
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Heading level={4} as="h2" id={headingId} className="min-w-0 truncate">
              {category.label}
            </Heading>
            <Badge variant="secondary" className="shrink-0 tabular-nums">
              <span aria-hidden>{tags.length}</span>
              <span className="sr-only">
                {t("focusTags.manager.tagCount", { count: tags.length })}
              </span>
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label={t("web.settings.focusTags.editAria", { name: category.label })}
            className="shrink-0"
          >
            <Pencil className="size-4" aria-hidden />
          </Button>
        </CardHeader>

        <CardContent className="p-4 pt-0">
          {tags.length === 0 && (
            <p className="mb-2 text-sm text-subtle">
              {pending
                ? t("focusTags.manager.categoryPending")
                : t("focusTags.manager.emptyCategory")}
            </p>
          )}
          <SortableContext items={tags.map((tag) => tag.id)} strategy={rectSortingStrategy}>
            <ul
              aria-label={t("focusTags.manager.categoryTagsLabel", { name: category.label })}
              className="flex flex-wrap items-center gap-1.5"
            >
              {tags.map((tag) => (
                <TagPill
                  key={tag.id}
                  tag={tag}
                  t={t}
                  filtering={filtering}
                  onEdit={() => onEditTag(tag)}
                />
              ))}
              {!filtering && (
                <li>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onAddTag}
                    disabled={pending}
                    aria-label={t("web.settings.focusTags.addTagAria", {
                      category: category.label,
                    })}
                    className="h-auto min-h-target gap-1.5 rounded-full border-dashed px-3 py-1.5 font-normal text-muted-foreground hover:text-foreground lg:h-auto desktop:min-h-9"
                  >
                    <Plus className="size-4" aria-hidden />
                    {t("focusTags.editor.add")}
                  </Button>
                </li>
              )}
            </ul>
          </SortableContext>
        </CardContent>
      </Card>
    </section>
  );
}

function TagPill({
  tag,
  t,
  filtering,
  onEdit,
}: {
  tag: TagRow;
  t: ReturnType<typeof useT>;
  filtering: boolean;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tag.id,
    disabled: filtering,
  });

  // The two halves each carry their own focus ring rather than sharing one on
  // the wrapper: they do different jobs (pick up vs. edit), and a ring around
  // both would say the wrong one is focused half the time. `focus-visible:z-10`
  // keeps a ring from being painted over by the next chip in the row.
  const half =
    "focus-visible:ring-ring ring-offset-background relative transition-colors focus-visible:z-10 focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-offset-2";

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10")}
    >
      <div
        className={cn(
          "flex min-h-target items-center rounded-full border border-input bg-muted desktop:min-h-9",
          isDragging && "shadow-brand-md",
        )}
      >
        {!filtering && (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={t("focusTags.manager.dragHandleAria", { name: tag.label })}
            className={cn(
              half,
              "hidden cursor-grab touch-none self-stretch rounded-l-full pr-1 pl-2.5 text-subtle hover:bg-secondary hover:text-foreground active:cursor-grabbing desktop:flex desktop:items-center",
            )}
          >
            <GripVertical className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            half,
            "self-stretch rounded-full px-3 text-sm hover:bg-secondary desktop:rounded-l-none desktop:pl-1.5",
            filtering && "desktop:rounded-l-full desktop:pl-3",
          )}
        >
          {tag.label}
        </button>
      </div>
    </li>
  );
}
