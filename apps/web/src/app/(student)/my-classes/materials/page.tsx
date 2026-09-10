import Link from "next/link";
import {
  AudioLines,
  BookOpenText,
  ChevronDown,
  ExternalLink,
  FileText,
  GraduationCap,
  Image as ImageIcon,
  Library,
  Link2,
  SearchX,
} from "lucide-react";
import { FALLBACK_TIMEZONE, type AppLocale, type StudentMaterialEntry } from "@spiralclass/shared";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { UrlSearchInput } from "@/components/ui/url-search-input";
import { requireStudent } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { getStudentLibraryView } from "@/lib/library/student-view";
import {
  countStudentMaterials,
  formatMediaDuration,
  isStudentMaterialFilter,
  matchesSearch,
  studentMaterialSearchText,
  type StudentMaterialFilter,
} from "@/lib/library/student-library-filter";
import { studentMaterialTitle } from "@/lib/materials/student-materials";
import { formatZonedShortDate } from "@/lib/date-display";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { cn } from "@/lib/utils";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { MaterialImagePreview } from "@/components/materials/material-image-preview";
import { MaterialDetails, MaterialOpenLink, MaterialPodcastPlayer } from "./material-tracking";

// The student's own shelf: every material she can see — level-browse,
// teacher-assigned and class-attached — merged upstream by
// lib/library/student-view and shown here grouped by the teacher's own
// categories.
//
// WHAT THIS PAGE IS FOR, since the layout follows from it. A student arrives
// with one of four questions: what did my teacher give me, what did we use in
// class, what can I practise at my level, and where is that one thing about
// the subjunctive. The first three are answered by the source filter, the
// fourth by search, and all four are answered at a glance by the row — which
// is where this page previously failed hardest. Source, level, unit, tags and
// type all rendered as the same anonymous grey pill, so "your teacher assigned
// you this" looked exactly like a tag, `classStartsAt` and `unit` were fetched
// and never drawn at all, and an unlabelled shelf read "File, File, Link,
// File". Now source and completion are worded Badges, the rest is one quiet
// meta line, and a material without a label is named after its own first
// heading or its host.
//
// FILTERING IS SERVER-SIDE, from `?show=` and `?q=`. Minting a signed URL is
// local SigV4 (see storage/provider) rather than a network call, so re-rendering
// the whole shelf per search costs one query and some HMAC — and in exchange
// the filters are bookmarkable, shareable and work with no JavaScript at all.

/**
 * Below this, the toolbar is more chrome than help — a shelf you can read in
 * one screen does not need to be searched. It appears anyway whenever a filter
 * is already on, or there would be no way to turn one off.
 */
const TOOLBAR_MIN_ITEMS = 8;

const MATERIALS_PATH = "/my-classes/materials";

type Shelved = {
  entry: StudentMaterialEntry;
  title: string;
  /**
   * The material has no name of its own, so its title fell back to the bare
   * type word ("File", "Lesson"). The meta line drops the type in that case
   * rather than printing it twice in two lines.
   */
  generic: boolean;
  /** Everything a student might type to find this row again. */
  searchText: string;
};

type Section = { key: string; label: string; items: Shelved[] };

// ---------------------------------------------------------------------------
// Row parts
// ---------------------------------------------------------------------------

/**
 * The glyph in a row's tile. Type at a glance is the cheapest scanning aid a
 * list of mixed media has, and this list mixes worksheets, links, pictures and
 * lessons written in the app.
 *
 * A picture wins over its underlying "file", because that is the thing the
 * student is actually looking at.
 */
function iconFor(e: StudentMaterialEntry) {
  if (e.isImage) return ImageIcon;
  if (e.attachmentKind === "content") return BookOpenText;
  if (e.attachmentKind === "link") return Link2;
  return FileText;
}

/**
 * The same distinction as a word, because an icon alone carries it by shape
 * only — the rule D-140 states for status, applied to the one other signal on
 * the row that is otherwise drawn and never written.
 */
function typeWord(e: StudentMaterialEntry, t: TFunction): string {
  if (e.isImage) return t("common.image");
  if (e.attachmentKind === "content") return t("web.studentMaterials.typeLesson");
  if (e.attachmentKind === "link") return t("materials.contentType.link");
  return t("materials.contentType.file");
}

function IconTile({ e }: { e: StudentMaterialEntry }) {
  const Icon = iconFor(e);
  return (
    <span
      className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      aria-hidden
    >
      <Icon className="size-5" />
    </span>
  );
}

/**
 * Where a material reached the student from, and whether her teacher has
 * marked it covered. Both are worded rather than coloured — a `success` tint
 * and an `info` tint are the same badge to a reader who cannot separate them.
 *
 * `browse` deliberately gets no badge: it is the default, and a chip on nine
 * rows in ten says nothing while making the two that matter harder to see.
 *
 * The two that do appear are weighted: an assignment is the one thing here the
 * student is expected to act on, so it takes a tinted `info`, while a class
 * attachment is context and takes the quieter `outline`. Outline rather than
 * `secondary` because in dark mode `secondary` sits about three points of
 * lightness off the card it is drawn on, and a badge you cannot see the edge
 * of is not a badge.
 */
function StatusBadges({
  e,
  t,
  locale,
  tz,
}: {
  e: StudentMaterialEntry;
  t: TFunction;
  locale: AppLocale;
  tz: string;
}) {
  const classDate = e.classStartsAt
    ? formatZonedShortDate(new Date(e.classStartsAt), tz, locale)
    : null;
  const source =
    e.source === "assigned" ? (
      <Badge variant="info">{t("library.source.assigned")}</Badge>
    ) : e.source === "class" && classDate ? (
      <Badge variant="outline">{t("web.studentMaterials.fromClassOn", { date: classDate })}</Badge>
    ) : e.source === "class" ? (
      <Badge variant="outline">{t("library.source.class")}</Badge>
    ) : null;

  if (!source && e.completed !== true) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {source}
      {e.completed === true ? <Badge variant="success">{t("library.done")}</Badge> : null}
    </span>
  );
}

/**
 * Level, unit, type and tags on one quiet line.
 *
 * These used to be five identical pills, which is how the row lost its
 * hierarchy: a pill is an emphasis device, and everything emphasised is
 * nothing emphasised. Separators are hidden from assistive tech, which reads
 * the parts as a list of phrases rather than announcing a middle dot four
 * times.
 */
function MetaLine({ parts }: { parts: string[] }) {
  if (parts.length === 0) return null;
  return (
    <span className="block text-sm text-muted-foreground">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`}>
          {i > 0 ? <span aria-hidden> · </span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function metaPartsFor(item: Shelved, t: TFunction): string[] {
  const e = item.entry;
  return [
    // Omitted when the row is already titled with it — "File" over "File · A2"
    // spends the row's two lines saying one thing.
    item.generic ? "" : typeWord(e, t),
    e.levelLabel,
    e.unit ? t("web.studentMaterials.unit", { unit: e.unit }) : "",
    ...e.tags.map((tag) => tag.label),
  ].filter((part): part is string => Boolean(part));
}

/** The generated podcast, when one is ready, with its length spelled out. */
function PodcastBlock({
  e,
  t,
  className,
}: {
  e: StudentMaterialEntry;
  t: TFunction;
  className?: string;
}) {
  if (!e.podcastUrl) return null;
  const duration = formatMediaDuration(e.podcastDurationSec);
  return (
    <div className={cn("space-y-2 rounded-lg bg-muted/40 p-3", className)}>
      <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <AudioLines className="size-4 shrink-0" aria-hidden />
        {t("web.studentMaterials.audioVersion")}
        {duration ? (
          <>
            <span aria-hidden>·</span>
            <span className="font-normal">{duration}</span>
          </>
        ) : null}
      </p>
      <MaterialPodcastPlayer
        materialId={e.id}
        src={e.podcastUrl}
        durationSeconds={e.podcastDurationSec}
      />
    </div>
  );
}

/** The file and link pieces of a unified material, as real buttons. */
function AttachmentActions({ e, t }: { e: StudentMaterialEntry; t: TFunction }) {
  if (!e.fileUrl && !e.linkUrl) return null;
  // Not `<Button asChild>`: Slot clones its child with props the tracking link
  // does not spread, which would silently drop the open-event handler.
  const style = cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5");
  return (
    <div className="flex flex-wrap gap-2">
      {e.fileUrl ? (
        <MaterialOpenLink materialId={e.id} href={e.fileUrl} className={style}>
          <FileText className="size-4" aria-hidden />
          {t("web.studentMaterials.openFile")}
          <span className="sr-only"> ({t("common.opensInNewTab")})</span>
        </MaterialOpenLink>
      ) : null}
      {e.linkUrl ? (
        <MaterialOpenLink materialId={e.id} href={e.linkUrl} className={style}>
          <ExternalLink className="size-4" aria-hidden />
          {t("web.studentMaterials.openLink")}
          <span className="sr-only"> ({t("common.opensInNewTab")})</span>
        </MaterialOpenLink>
      ) : null}
    </div>
  );
}

const ROW_SHELL =
  "group bg-card border-border hover:border-primary/60 rounded-lg border transition-colors";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A material that opens somewhere else — a file or a link.
 *
 * The title's hit area is stretched over the whole row (`after:inset-0`) so the
 * target is a card rather than a line of text, while the accessibility tree
 * still sees one link named by the title. Anything interactive nested inside —
 * the picture, the audio player — is lifted back above that overlay.
 */
function OpenableRow({
  item,
  t,
  locale,
  tz,
}: {
  item: Shelved;
  t: TFunction;
  locale: AppLocale;
  tz: string;
}) {
  const e = item.entry;
  return (
    <li
      className={cn(
        ROW_SHELL,
        "relative flex min-h-target items-start gap-3 p-3 hover:bg-muted/40",
      )}
    >
      <IconTile e={e} />
      <div className="min-w-0 flex-1 space-y-1.5">
        {e.viewUrl ? (
          <MaterialOpenLink
            materialId={e.id}
            href={e.viewUrl}
            className="block rounded-sm leading-snug font-semibold after:absolute after:inset-0 after:content-['']"
          >
            {item.title}
            <span className="sr-only"> ({t("common.opensInNewTab")})</span>
          </MaterialOpenLink>
        ) : (
          <span className="block leading-snug font-semibold">{item.title}</span>
        )}
        <StatusBadges e={e} t={t} locale={locale} tz={tz} />
        <MetaLine parts={metaPartsFor(item, t)} />
        {e.isImage && e.fileUrl ? (
          <MaterialImagePreview viewUrl={e.fileUrl} label={item.title} className="relative z-10" />
        ) : null}
        <PodcastBlock e={e} t={t} className="relative z-10" />
        {/* Both pieces of a unified file+link material, since the stretched
            title can only lead to one of them. */}
        {e.fileUrl && e.linkUrl ? (
          <div className="relative z-10">
            <AttachmentActions e={e} t={t} />
          </div>
        ) : null}
      </div>
      {/* The affordance, not the target: the whole row already opens it. */}
      {e.viewUrl ? (
        <ExternalLink
          className="mt-2.5 size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
          aria-hidden
        />
      ) : null}
    </li>
  );
}

/**
 * A lesson written in the app, which is read in place rather than opened.
 *
 * `<summary>` takes phrasing content only, so every element inside it is a
 * span made to lay out with utilities — the previous version nested a `<div>`
 * inside a `<span>` inside the summary, which is invalid and which is also why
 * `truncate` on the title never did anything.
 */
function ReadableRow({
  item,
  t,
  locale,
  tz,
}: {
  item: Shelved;
  t: TFunction;
  locale: AppLocale;
  tz: string;
}) {
  const e = item.entry;
  return (
    <li>
      <MaterialDetails
        materialId={e.id}
        className={cn(ROW_SHELL, "[&_summary::-webkit-details-marker]:hidden")}
        summary={
          <summary className="flex min-h-target cursor-pointer list-none items-start gap-3 rounded-lg p-3 transition-colors hover:bg-muted/40">
            <IconTile e={e} />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="block leading-snug font-semibold">{item.title}</span>
              <StatusBadges e={e} t={t} locale={locale} tz={tz} />
              <MetaLine parts={metaPartsFor(item, t)} />
            </span>
            <ChevronDown
              className="mt-2.5 size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
        }
      >
        <div className="space-y-4 border-t border-border p-4">
          <PodcastBlock e={e} t={t} />
          <ClassContentMarkdown body={e.body ?? ""} />
          {e.isImage && e.fileUrl ? (
            <MaterialImagePreview viewUrl={e.fileUrl} label={item.title} />
          ) : null}
          <AttachmentActions e={e} t={t} />
        </div>
      </MaterialDetails>
    </li>
  );
}

function MaterialRow(props: { item: Shelved; t: TFunction; locale: AppLocale; tz: string }) {
  return props.item.entry.body ? <ReadableRow {...props} /> : <OpenableRow {...props} />;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const FILTER_LABELS: Record<StudentMaterialFilter, Parameters<TFunction>[0]> = {
  all: "web.studentMaterials.filterAll",
  assigned: "web.studentMaterials.filterAssigned",
  class: "web.studentMaterials.filterClass",
  browse: "web.studentMaterials.filterBrowse",
};

function filterHref(next: StudentMaterialFilter, q: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (next !== "all") params.set("show", next);
  const qs = params.toString();
  return qs ? `${MATERIALS_PATH}?${qs}` : MATERIALS_PATH;
}

function SourceFilters({
  active,
  counts,
  q,
  t,
}: {
  active: StudentMaterialFilter;
  counts: Record<StudentMaterialFilter, number>;
  q: string;
  t: TFunction;
}) {
  // Only the buckets that hold something, plus whichever is on — a chip that
  // can only ever return nothing is a dead end, and one the student is
  // standing in must stay visible so she can leave it.
  const buckets = (["assigned", "class", "browse"] as const).filter(
    (key) => counts[key] > 0 || active === key,
  );
  // With one source in play the chips restate the shelf they sit above.
  if (buckets.length < 2) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-labelledby="materials-filter-legend"
    >
      <span id="materials-filter-legend" className="text-sm font-semibold text-muted-foreground">
        {t("web.studentMaterials.filterLegend")}
      </span>
      {(["all", ...buckets] as const).map((key) => {
        const selected = active === key;
        return (
          <Link
            key={key}
            href={filterHref(key, q)}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "inline-flex min-h-target items-center gap-2 rounded-full border px-4 text-sm transition-colors",
              selected
                ? "border-primary bg-primary font-semibold text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t(FILTER_LABELS[key])}
            {/* The inverse of the chip's own pairing rather than an invented
                tint: `bg-primary-foreground/20` measured 3.66:1 in light mode,
                a colour no token names and the contrast test cannot assert. */}
            <span
              className={cn(
                "rounded-full px-1.5 text-xs",
                selected ? "bg-primary-foreground text-primary" : "bg-muted",
              )}
            >
              {counts[key]}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function StudentMaterialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const student = await requireStudent();
  const [locale, t, view, sp] = await Promise.all([
    getPreferredLocale(),
    getT(),
    getStudentLibraryView(student.id),
    searchParams,
  ]);

  const tz = student.timezone ?? FALLBACK_TIMEZONE;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const show = isStudentMaterialFilter(sp.show) ? sp.show : "all";

  // One pass over the shelf: each entry gets the name it will be shown under
  // and the text it will be searched by, so neither is recomputed per render
  // branch and the two can never disagree.
  const sections: Section[] = view.categories.map((g) => ({
    key: g.categoryId ?? "__other__",
    label: g.categoryId === null ? t("library.otherCategory") : g.categoryLabel,
    items: g.items.map((entry) => {
      // Every fallback is the SAME word — the one the meta line would have
      // printed — so an unnamed material is titled by its type exactly once.
      // A picture titles itself "Image" rather than "File", which is what the
      // student is actually looking at.
      const generic = typeWord(entry, t);
      const title = studentMaterialTitle(entry, {
        content: generic,
        file: generic,
        link: generic,
      });
      return {
        entry,
        title,
        generic: title === generic,
        searchText: studentMaterialSearchText({
          title,
          unit: entry.unit,
          levelLabel: entry.levelLabel,
          tags: entry.tags,
          body: entry.body,
        }),
      };
    }),
  }));

  // Counts come from the UNFILTERED shelf, so a chip keeps saying how much is
  // behind it while another chip is the one selected.
  const counts = countStudentMaterials(
    sections.flatMap((s) => s.items.map((item) => item.entry.source)),
  );

  const visible = sections
    .map((s) => ({
      ...s,
      items: s.items.filter(
        (item) =>
          (show === "all" || item.entry.source === show) && matchesSearch(item.searchText, q),
      ),
    }))
    .filter((s) => s.items.length > 0);
  const shown = visible.reduce((n, s) => n + s.items.length, 0);

  // Only an unfiltered render is a "view". Every keystroke re-runs this
  // component, and counting each of them would turn one student opening her
  // materials into a dozen library_viewed events.
  if (!q && show === "all") {
    trackServerEvent({
      name: "library_viewed",
      distinctId: student.id,
      properties: { surface: "web", itemCount: counts.all },
    });
  }

  const filtered = Boolean(q) || show !== "all";
  const showToolbar = counts.all >= TOOLBAR_MIN_ITEMS || filtered;
  // A single unnamed bucket is not a grouping — heading the whole shelf
  // "Other" tells the student nothing she did not already know.
  const unlabelled = visible.length === 1 && visible[0].key === "__other__";

  return (
    <PageShell width="reading">
      <PageHeader
        title={t("library.title")}
        description={t("web.studentMaterials.subtitle")}
        actions={
          view.levelLabel ? (
            <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-sm">
              <GraduationCap className="size-4 shrink-0" aria-hidden />
              {t("library.yourLevel", { level: view.levelLabel })}
            </Badge>
          ) : null
        }
      />

      {showToolbar ? (
        <div className="space-y-3">
          <UrlSearchInput placeholder={t("web.studentMaterials.searchPlaceholder")} />
          <SourceFilters active={show} counts={counts} q={q} t={t} />
          {filtered && shown > 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("web.studentMaterials.count", { count: shown })}
            </p>
          ) : null}
        </div>
      ) : null}

      {visible.map((section) => {
        const rows = (
          <ul className="space-y-2">
            {section.items.map((item) => (
              <MaterialRow
                key={`${section.key}-${item.entry.id}`}
                item={item}
                t={t}
                locale={locale}
                tz={tz}
              />
            ))}
          </ul>
        );
        return unlabelled ? (
          <div key={section.key}>{rows}</div>
        ) : (
          <Panel
            key={section.key}
            title={section.label}
            actions={
              <span className="text-sm text-muted-foreground">
                {t("web.studentMaterials.count", { count: section.items.length })}
              </span>
            }
          >
            {rows}
          </Panel>
        );
      })}

      {shown === 0 ? (
        counts.all === 0 ? (
          <EmptyState
            icon={Library}
            title={t("web.studentMaterials.emptyTitle")}
            description={view.hasLevel ? t("library.empty") : t("library.noLevel")}
          />
        ) : (
          <EmptyState
            icon={SearchX}
            title={t("web.studentMaterials.noMatchesTitle")}
            description={t("web.studentMaterials.noMatchesBody")}
            action={
              <Button asChild variant="outline">
                <Link href={MATERIALS_PATH}>{t("web.studentMaterials.showEverything")}</Link>
              </Button>
            }
          />
        )
      ) : null}
    </PageShell>
  );
}
