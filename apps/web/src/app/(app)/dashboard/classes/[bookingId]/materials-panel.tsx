"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteLibraryMaterialAction } from "@/app/actions/library";
import {
  attachLibraryMaterialToBookingAction,
  detachLibraryMaterialFromBookingAction,
  type AttachLibraryMaterialState,
} from "@/app/actions/booking-library-materials";
import type { ClassContentSource } from "@/components/materials/material-form";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { MaterialImagePreview } from "@/components/materials/material-image-preview";
import { Collapsible } from "@/components/ui/collapsible";
import { useT } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";
import {
  groupMaterialsByCategory,
  groupMaterialsByLevel,
  hasAnswerKey,
  parseMaterialDoc,
  type MaterialCategoryMeta,
  type MaterialTag,
} from "@spiralclass/shared";

// Past this many attached materials, the list collapses to avoid pushing
// lesson notes/homework below the fold — see the class-detail redesign audit.
const MATERIALS_COLLAPSE_THRESHOLD = 4;

// Level chip in the attach-from-library picker. Matches the Materials page's
// own filter chips (dashboard/materials/page.tsx) so the two level controls
// read as the same control in two places.
const attachChipClass = (selected: boolean) =>
  `rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
    selected ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
  }`;

// The unified per-class materials panel (docs/features/library-materials.md).
// Per the class-detail redesign brief
// (docs/features/classes-lesson-content.md), the heavy MaterialForm
// "write" editor no longer renders inline here — a `multiline` textarea
// sitting mid-scroll traps drag gestures on mobile and buries the
// lifecycle-override actions below it. Instead this panel shows a read-only
// rendered preview of the saved class content plus an "Edit content" link to
// its own page (content/edit/page.tsx). The attach-from-library sub-form and
// the attached-materials list stay here — they're not the heavy editor.

type SendTiming = "confirmation" | "t_5d" | "t_24h" | "t_1h" | null;

type MaterialRow = {
  id: string;
  label: string | null;
  attachmentKind: "file" | "link";
  isImage?: boolean;
  viewUrl: string | null;
  sendTiming: SendTiming;
  tags: MaterialTag[];
};

// Gap G3 — a library item attached to this class instead of freshly uploaded
// here.
type AttachedLibraryRow = {
  libraryMaterialId: string;
  label: string | null;
  viewUrl: string | null;
  sendTiming: SendTiming;
  tags: MaterialTag[];
  // Native-content (markdown body) items only — lets the row expand an
  // inline preview instead of the teacher only having a remove button.
  body?: string | null;
};

// Fresh + attached rows unified for category grouping — `source` keeps the
// right remove action and caption per row.
type DisplayRow = {
  key: string;
  label: string | null;
  viewUrl: string | null;
  sendTiming: SendTiming;
  tags: MaterialTag[];
  source: "fresh" | "library";
  attachmentKind?: "file" | "link";
  isImage?: boolean;
  body?: string | null;
};

type LibraryOption = { id: string; label: string; levelId: string | null; levelLabel: string };

export function MaterialsPanel({
  bookingId,
  content,
  contentFileUrl = null,
  contentLinkUrl = null,
  materials,
  libraryOptions = [],
  attachedLibrary = [],
  categories = [],
}: {
  bookingId: string;
  content?: { id: string; body: string; source: ClassContentSource };
  // The file/link that ride on the same content row (unified material), for a
  // read-only "attached to this content" line.
  contentFileUrl?: string | null;
  contentLinkUrl?: string | null;
  materials: MaterialRow[];
  libraryOptions?: LibraryOption[];
  attachedLibrary?: AttachedLibraryRow[];
  categories?: MaterialCategoryMeta[];
}) {
  const t = useT();
  const timingLabel = (timing: SendTiming) =>
    timing === null ? t("materials.timing.always") : t(`materials.timing.${timing}` as const);

  // Merge fresh + attached into one list, grouped by category (same model as
  // the student class page), keeping each row's source for its remove action.
  const displayRows: DisplayRow[] = [
    ...materials.map((m) => ({
      key: m.id,
      label: m.label,
      viewUrl: m.viewUrl,
      sendTiming: m.sendTiming,
      tags: m.tags,
      source: "fresh" as const,
      attachmentKind: m.attachmentKind,
      isImage: m.isImage,
    })),
    ...attachedLibrary.map((a) => ({
      key: a.libraryMaterialId,
      label: a.label,
      viewUrl: a.viewUrl,
      sendTiming: a.sendTiming,
      tags: a.tags,
      source: "library" as const,
      body: a.body,
    })),
  ];
  const materialGroups = groupMaterialsByCategory(displayRows, categories, "");

  const attachedIds = new Set(attachedLibrary.map((a) => a.libraryMaterialId));
  const availableToAttach = libraryOptions.filter((o) => !attachedIds.has(o.id));

  // Level-first, adapted for a compact multi-select (see groupMaterialsByLevel).
  // The picker used to be one flat scroll of the entire library with the level
  // trailing each row as "· A2" — the same find-it-by-scanning problem the
  // Materials page had. It's now grouped under level headings in ladder order,
  // with an optional single-level narrowing.
  //
  // `null` = every level. NOT defaulted to the class student's own level: the
  // class page already has a separate opt-in "at their level" shelf doing that,
  // and hiding the rest by default would make a teacher reaching deliberately
  // above or below that level think her library was empty.
  const [attachLevel, setAttachLevel] = useState<string | null>(null);
  const attachLevels = groupMaterialsByLevel(
    availableToAttach,
    t("web.dashboard.classes.materials.noLevel"),
  );
  // A narrowed-to level disappears once its last item is attached (the group
  // list is built from what's still available). Fall back to all levels rather
  // than rendering an empty box under a chip that no longer exists.
  const activeLevel = attachLevels.some((g) => g.levelId === attachLevel) ? attachLevel : null;
  // Narrowing filters what's VISIBLE only — the checked set below is state and
  // its hidden inputs render outside this list, so a selection made in one
  // level survives switching to another and still submits. The button's count
  // is what tells the teacher those off-screen picks are still there.
  const visibleLevels =
    activeLevel === null ? attachLevels : attachLevels.filter((g) => g.levelId === activeLevel);

  // Multi-select: a set of checked library-item ids attached in one submit.
  const [attachIds, setAttachIds] = useState<Set<string>>(new Set());
  const toggleAttachId = (id: string) =>
    setAttachIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Default to "confirmation" (visible as soon as the class is confirmed) so a
  // teacher who attaches without touching the timing doesn't accidentally hide
  // the material from the student until 24h before class.
  const [attachTiming, setAttachTiming] = useState<Exclude<SendTiming, null>>("confirmation");
  const [attachState, attachAction, attaching] = useActionState<
    AttachLibraryMaterialState,
    FormData
  >(attachLibraryMaterialToBookingAction, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.dashboard.classes.materials.title")}</CardTitle>
        <CardDescription>{t("materials.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs font-medium">
              {t("web.dashboard.classes.detail.contentPreviewTitle")}
            </p>
            <div className="flex items-center gap-3">
              {/* Direct PDF download of the saved class content — same
                  server-rendered export the Materials library page links to
                  (/api/materials/[id]/pdf), so the browser saves the file
                  straight away instead of routing through a print view. This
                  one is the STUDENT copy: `[!answer]` blocks are stripped
                  unless `?answers=1` asks for them, as on the library page. */}
              {content?.body && (
                <a
                  href={`/api/materials/${content.id}/pdf`}
                  className="text-sm underline underline-offset-2"
                >
                  {t("web.materials.downloadPdf")}
                </a>
              )}
              {content?.body && hasAnswerKey(parseMaterialDoc(content.body)) && (
                <a
                  href={`/api/materials/${content.id}/pdf?answers=1`}
                  aria-label={t("web.materials.downloadPdfAnswerKey")}
                  className="text-sm underline underline-offset-2"
                >
                  {t("web.materials.downloadAnswerKey")}
                </a>
              )}
              <Link
                href={`/dashboard/classes/${bookingId}/content/edit`}
                className="text-sm underline underline-offset-2"
              >
                {t("web.dashboard.classes.detail.editContent")}
              </Link>
            </div>
          </div>
          {content?.body ? (
            <ClassContentMarkdown body={content.body} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.classes.detail.noContentYet")}
            </p>
          )}
          {(contentFileUrl || contentLinkUrl) && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted-foreground">
                {t("web.dashboard.classes.materials.attachedToContent")}
              </span>
              {contentFileUrl && (
                <a href={contentFileUrl} target="_blank" rel="noreferrer" className="underline">
                  {t("materials.fileAttachment")}
                </a>
              )}
              {contentLinkUrl && (
                <a href={contentLinkUrl} target="_blank" rel="noreferrer" className="underline">
                  {t("materials.linkAttachment")}
                </a>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4 border-t pt-4">
          {displayRows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.classes.materials.noneYet")}
            </p>
          ) : displayRows.length > MATERIALS_COLLAPSE_THRESHOLD ? (
            <Collapsible
              title={t("materials.showMore", { count: displayRows.length })}
              defaultOpen={false}
            >
              <MaterialGroupList
                groups={materialGroups}
                t={t}
                timingLabel={timingLabel}
                bookingId={bookingId}
              />
            </Collapsible>
          ) : (
            <MaterialGroupList
              groups={materialGroups}
              t={t}
              timingLabel={timingLabel}
              bookingId={bookingId}
            />
          )}
        </div>

        {availableToAttach.length > 0 && (
          <form action={attachAction} className="bg-muted/40 space-y-3 rounded-md border p-3">
            <input type="hidden" name="bookingId" value={bookingId} />
            <Label>{t("web.dashboard.classes.materials.attachFromLibrary")}</Label>
            {/* Level narrowing. Only worth showing when there's more than one
                level to choose between — a single-level library is already as
                narrow as it gets. */}
            {attachLevels.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAttachLevel(null)}
                  className={attachChipClass(activeLevel === null)}
                >
                  {t("web.materials.filterAll")}
                </button>
                {attachLevels.map((g) => (
                  <button
                    key={g.levelId ?? "none"}
                    type="button"
                    onClick={() => setAttachLevel(g.levelId)}
                    className={attachChipClass(activeLevel === g.levelId)}
                  >
                    {g.levelLabel}
                  </button>
                ))}
              </div>
            )}
            {/* Multi-select: check any number of library items, across levels;
                one hidden libraryMaterialId is submitted per checked item. */}
            <div className="bg-background max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
              {visibleLevels.map((g) => (
                <div key={g.levelId ?? "none"} className="space-y-1">
                  {/* The heading carries the level, so the row no longer needs
                      to repeat it as a "· A2" suffix on every single line. */}
                  <p className="bg-background text-muted-foreground sticky top-0 px-2 py-0.5 text-xs font-semibold">
                    {g.levelLabel}
                  </p>
                  {g.items.map((o) => (
                    <label
                      key={o.id}
                      className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={attachIds.has(o.id)}
                        onChange={() => toggleAttachId(o.id)}
                      />
                      <span className="min-w-0 truncate">{o.label}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <Select
              value={attachTiming}
              onValueChange={(v) => setAttachTiming(v as Exclude<SendTiming, null>)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="confirmation">{timingLabel("confirmation")}</SelectItem>
                <SelectItem value="t_5d">{timingLabel("t_5d")}</SelectItem>
                <SelectItem value="t_24h">{timingLabel("t_24h")}</SelectItem>
                <SelectItem value="t_1h">{timingLabel("t_1h")}</SelectItem>
              </SelectContent>
            </Select>
            {[...attachIds].map((id) => (
              <input key={id} type="hidden" name="libraryMaterialId" value={id} />
            ))}
            <input type="hidden" name="sendTiming" value={attachTiming} />
            <Button type="submit" variant="secondary" disabled={attaching || attachIds.size === 0}>
              {attaching
                ? t("web.dashboard.classes.materials.attaching")
                : attachIds.size > 1
                  ? t("web.dashboard.classes.materials.attachCount", { count: attachIds.size })
                  : t("web.dashboard.classes.materials.attachFromLibrary")}
            </Button>
            {attachState?.error && <p className="text-destructive text-sm">{attachState.error}</p>}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// Extracted so the collapsed and expanded render paths share one
// implementation instead of drifting apart.
function MaterialGroupList({
  groups,
  t,
  timingLabel,
  bookingId,
}: {
  groups: ReturnType<typeof groupMaterialsByCategory<DisplayRow>>;
  t: TFunction;
  timingLabel: (timing: SendTiming) => string;
  bookingId: string;
}) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.categoryId ?? "__other__"} className="space-y-2">
          <p className="text-muted-foreground text-xs font-semibold">
            {g.categoryId === null ? t("library.otherCategory") : g.categoryLabel}
          </p>
          <ul className="space-y-2 text-sm">
            {g.items.map((m) => {
              const fallback =
                m.attachmentKind === "link"
                  ? t("materials.linkAttachment")
                  : t("materials.fileAttachment");
              return (
                <li
                  key={m.key}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    {m.viewUrl ? (
                      <a
                        href={m.viewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline underline-offset-2"
                      >
                        {m.label ?? fallback}
                      </a>
                    ) : (
                      <span className="text-muted-foreground font-medium">
                        {m.label ?? fallback}
                      </span>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {m.source === "library"
                        ? `${t("web.dashboard.classes.materials.fromLibrary")} · ${timingLabel(m.sendTiming)}`
                        : timingLabel(m.sendTiming)}
                    </p>
                    {m.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {m.tags.map((tag) => (
                          <span
                            key={tag.id}
                            className="text-muted-foreground rounded-full border px-2 py-0.5 text-sm"
                          >
                            {tag.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* The teacher sees the same inline preview her student
                        will, so "is this the right picture?" needs no round
                        trip through the file. */}
                    {m.isImage && (
                      <MaterialImagePreview
                        viewUrl={m.viewUrl}
                        label={m.label}
                        className="mt-2 max-w-sm"
                      />
                    )}
                    {m.source === "library" && m.body && (
                      <details className="group">
                        <summary className="text-muted-foreground cursor-pointer text-xs">
                          {t("web.materials.previewContent")}
                        </summary>
                        <div className="mt-2 border-t pt-2">
                          <ClassContentMarkdown body={m.body} />
                        </div>
                      </details>
                    )}
                  </div>
                  {m.source === "library" ? (
                    <form action={detachLibraryMaterialFromBookingAction}>
                      <input type="hidden" name="bookingId" value={bookingId} />
                      <input type="hidden" name="libraryMaterialId" value={m.key} />
                      <Button type="submit" variant="ghost" size="sm">
                        {t("materials.remove")}
                      </Button>
                    </form>
                  ) : (
                    <form action={deleteLibraryMaterialAction}>
                      <input type="hidden" name="materialId" value={m.key} />
                      <Button type="submit" variant="ghost" size="sm">
                        {t("materials.remove")}
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
