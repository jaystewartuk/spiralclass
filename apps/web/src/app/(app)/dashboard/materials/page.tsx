import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import {
  browseLevelFilter,
  browseLevelParam,
  hasAnswerKey,
  parseMaterialDoc,
  resolveMaterialsBrowseMode,
} from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { getTeacherLevels } from "@/lib/levels";
import { getTeacherFocusGroups } from "@/lib/focus-tags";
import { listClassContentTemplates } from "@/lib/materials/templates";
import { hasAnthropicCreds, podcastsEnabled } from "@/lib/env";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { getStorageProvider } from "@/lib/storage/provider";
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";
import {
  countLibraryMaterials,
  isLibrarySort,
  listLibraryMaterialsRows,
  type LibraryFilters,
} from "@/lib/library/library-queries";
import { resolvePage } from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Archive, FilterX, Layers, LibraryBig, Sparkles } from "lucide-react";
import {
  materialsClearFiltersHref,
  materialsHref,
  materialsPageParams,
  type MaterialsUrlState,
} from "@/lib/library/materials-href";
import { UrlSearchInput } from "@/components/ui/url-search-input";
import { MaterialsSort } from "./materials-sort";
import { LevelHub } from "./level-hub";
import { AddMaterialSheet } from "./add-material-sheet";
import { LibraryToolbar } from "./library-toolbar";
import { MaterialCard } from "./material-card";
import { listMaterialRevisionsFor } from "@/app/actions/library";

// Teacher library management — reusable, level-tagged materials (bookingId:null;
// per-class private materials live on the class page). A full-width,
// server-filtered, paginated list with a slide-over "Add material" drawer.
// Filtering/sorting/paging all live in the URL so the RSC re-renders one page
// at a time (see lib/library/library-queries) — the page no longer loads the
// whole library or filters in memory, and per-row signed URLs are minted only
// for the ~PAGE_SIZE rows actually shown.
//
// This file is the ORCHESTRATION: auth, the filter parse, the two queries, the
// per-row presign, and which of the three views to render. The views themselves
// are ./level-hub.tsx (the picker), ./library-toolbar.tsx (breadcrumb, shelf
// switcher, filters) and ./material-card.tsx (one row) — each carries the
// reasoning for its own shape.
//
// LEVEL-FIRST NAVIGATION: with no `?level=`, this renders a level hub instead
// of the list — the teacher picks A1/A2/B1… and works inside it. `?level=<id>`
// is that shelf; `?level=all` is the flat list the page has always been. The
// rule lives in @spiralclass/shared/materials-browse; the URL param itself is
// unchanged, so every existing deep link still works. Nothing about filtering changed — the full chip bar is still
// there one level in.
//
// Two things worth not re-breaking:
//  - The hub branch returns BEFORE the count/rows/signed-URL work, so landing
//    on Materials costs one level query and mints no signed URLs.
//  - Inside the list, "All" on the level row points at ALL_LEVELS, never at a
//    dropped param — dropping it would eject the teacher to the hub mid-filter
//    (see lib/library/materials-href.ts and ./library-toolbar.tsx).

// Roomy rows are tall, so a small page keeps the scroll length sane while
// still bounding the query + presign work.
const PAGE_SIZE = 24;

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const aiEnabled = hasAnthropicCreds();
  // Podcast generation needs both the script (Claude) and the audio (ElevenLabs).
  const podcastEnabled = aiEnabled && podcastsEnabled();
  // Plan gate for the AI authoring surfaces (class_content rides
  // canScheduleMaterials) — proactively disables Generate/Edit-with-AI for a
  // Free teacher instead of letting her submit and hit a 403.
  const isPro = (await loadEntitlements(teacher.id)).isPro;
  const sp = await searchParams;
  const categoryFilter = typeof sp.category === "string" ? sp.category : null;
  const levelParam = typeof sp.level === "string" ? sp.level : null;
  const typeFilter = typeof sp.type === "string" ? sp.type : null;
  const visibilityFilter = typeof sp.visibility === "string" ? sp.visibility : null;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const sort = isLibrarySort(sp.sort) ? sp.sort : "recent";
  const view = sp.view === "archived" ? "archived" : "active";

  const [levels, focusGroups, templates, libraryCount, archivedCount] = await Promise.all([
    getTeacherLevels(teacher.id),
    getTeacherFocusGroups(teacher.id, teacher.targetLanguage, locale),
    listClassContentTemplates(teacher.id),
    prisma.libraryMaterial.count({
      where: { teacherId: teacher.id, bookingId: null, archived: false },
    }),
    prisma.libraryMaterial.count({
      where: { teacherId: teacher.id, bookingId: null, archived: true },
    }),
  ]);

  const levelLabel = new Map(levels.map((l) => [l.id, l.label]));
  const levelOptions = levels.map((l) => ({ id: l.id, label: l.label }));
  // Only honor filter values the teacher actually has; ignore anything else.
  const validCategory =
    categoryFilter && focusGroups.some((g) => g.categoryId === categoryFilter)
      ? categoryFilter
      : null;
  const validType =
    typeFilter === "content" || typeFilter === "file" || typeFilter === "link" ? typeFilter : null;
  const validVisibility =
    visibilityFilter === "at_or_below" || visibilityFilter === "exact" || visibilityFilter === "all"
      ? visibilityFilter
      : null;

  const emptyLibrary = libraryCount === 0 && archivedCount === 0;

  // Hub vs. one level vs. all levels. Anything already narrowing the view
  // (search, another chip, the archived shelf, a page number) forces the list,
  // so an existing bookmark never lands on the picker with its filters dropped.
  const mode = resolveMaterialsBrowseMode({
    levelParam,
    levelIds: levels.map((l) => l.id),
    hasOtherNarrowing: Boolean(
      validCategory || validType || validVisibility || q || view === "archived" || sp.page,
    ),
  });
  const validLevel = browseLevelFilter(mode);

  const filters: LibraryFilters = {
    teacherId: teacher.id,
    archived: view === "archived",
    category: validCategory,
    level: validLevel,
    type: validType,
    visibility: validVisibility,
    q,
  };

  // The "Add material" trigger. Rendered in the header and again inside the two
  // empty states that are waiting for exactly this click — each gets its own
  // Sheet instance, which costs nothing, because the sheet holds no state worth
  // sharing and the drawer that opens is identical. Absent with no levels: a
  // material must be filed under one.
  const addMaterial =
    levels.length > 0 ? (
      <AddMaterialSheet
        levels={levelOptions}
        focusGroups={focusGroups}
        templates={templates}
        aiEnabled={aiEnabled}
        isPro={isPro}
      />
    ) : null;

  // Shared by both branches so the hub and the list carry one header.
  // PageHeader owns the title/description/actions arrangement for all 80-odd
  // screens; this one used to hand-roll its own flex row around a bare
  // PageHeader, which is how its buttons ended up wrapping differently from
  // every other page's.
  const header = (
    <PageHeader
      title={t("web.materials.pageTitle")}
      description={t("web.materials.pageDescription")}
      actions={
        <>
          {aiEnabled && (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/settings/materials">
                <Sparkles className="size-4" aria-hidden />
                {t("web.settings.materialStyle.hubLink")}
              </Link>
            </Button>
          )}
          {addMaterial}
        </>
      }
    />
  );

  // Search sits ABOVE the hub/list split, in the SAME child slot of <main> in
  // both branches, so flipping between them never remounts the input. It's a
  // client component holding the in-flight text: remount it and the teacher
  // loses focus mid-word, which is exactly what a hub search does on its first
  // keystroke (?q= flips the mode to the list). `page` is cleared on every
  // change because a new search
  // invalidates the window the old page number described.
  const searchSlot = !emptyLibrary ? (
    <UrlSearchInput placeholder={t("web.materials.searchPlaceholder")} clearParams={["page"]} />
  ) : null;

  // A library with nothing in it, on either shelf. Said once here rather than
  // in each of the two branches below, because the answer is the same in both
  // and the branch that reached it is not something the teacher can see.
  const emptyLibraryState = (
    <EmptyState
      icon={LibraryBig}
      title={t("web.materials.emptyTitle")}
      description={t("web.materials.emptyBody")}
      action={addMaterial}
    />
  );

  // The teacher has archived every level she has, so there is no shelf to file
  // a material under. `getTeacherLevels` seeds the six CEFR levels for anyone
  // who has none, so this is reachable only that way — and there is no "add a
  // level" screen to send her to, so this states the blocker rather than
  // offering a link to nowhere. Only the list branch can reach it (see the hub
  // branch below).
  const noLevelsState = (
    <EmptyState
      icon={Layers}
      title={t("web.materials.noLevelsTitle")}
      description={t("web.materials.noLevelsYet")}
    />
  );

  // The level picker. Returns before any material query — see the file header.
  // `levels.length > 0` is guaranteed here: resolveMaterialsBrowseMode sends a
  // teacher with no levels to the flat list rather than to an empty picker.
  if (mode.kind === "hub") {
    return (
      <PageShell width="wide">
        {header}
        {searchSlot}
        <LevelHub levels={levels} showAllLevels={!emptyLibrary} />
        {emptyLibrary && emptyLibraryState}
      </PageShell>
    );
  }

  // Count first so the page can be clamped to a valid range before we compute
  // `skip` (an out-of-range ?page= would otherwise fetch an empty window).
  const total = await countLibraryMaterials(filters);
  const pageState = resolvePage(
    { page: typeof sp.page === "string" ? sp.page : undefined },
    total,
    PAGE_SIZE,
  );
  const rows = await listLibraryMaterialsRows(filters, {
    sort,
    skip: pageState.skip,
    take: PAGE_SIZE,
  });

  // Mint a fresh signed URL per file (bounded to this page) so the teacher can
  // preview her own items, and — for body items — load version history so the
  // inline editor can offer restore without a second round-trip once opened.
  const storage = getStorageProvider();
  const items = await Promise.all(
    rows.map(async (m) => ({
      ...m,
      viewUrl: await pickMaterialsUrl(storage, { storagePath: m.storagePath, linkUrl: m.linkUrl }),
      // Drives the second "with answer key" download below. Derived from the
      // live body at read time (the same parse the preview renderer runs), so
      // it can never go stale against an edit the way a stored flag would.
      hasAnswerKey: Boolean(m.body) && hasAnswerKey(parseMaterialDoc(m.body!)),
      revisions:
        view === "active" && m.body
          ? await listMaterialRevisionsFor({ teacherId: teacher.id, materialId: m.id })
          : [],
    })),
  );

  // What is NARROWING the shelf, counted for the "clear filters" affordance.
  // `level` and `view` are deliberately not in it — those choose which shelf
  // she is on, and clearing them would move her rather than widen it.
  const activeFilters = [validCategory, validType, validVisibility, q || null].filter(Boolean);
  const anyFilter = activeFilters.length > 0;

  const visibilityLabel = (v: string) => {
    if (v === "all") return t("web.materials.visibilityAll");
    if (v === "exact") return t("web.materials.visibilityExact");
    return t("web.materials.visibilityAtOrBelowShort");
  };

  // One formatter for the whole page rather than one per row, in the teacher's
  // own zone: a material added late on the 1st in London was showing as the 2nd
  // to anyone reading it in UTC.
  const addedFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: teacher.timezone,
  });

  // Every in-list link is built from this one state. `level` is the mode's own
  // param (a level id or ALL_LEVELS) — NOT `validLevel` — so a filter click
  // inside the all-levels list stays in the list instead of falling back to the
  // hub. See lib/library/materials-href.ts.
  const urlState: MaterialsUrlState = {
    level: browseLevelParam(mode),
    category: validCategory,
    type: validType,
    visibility: validVisibility,
    q,
    sort,
    view,
  };
  const pageParams = materialsPageParams(urlState);

  return (
    <PageShell width="wide">
      {header}
      {searchSlot}

      {levels.length === 0 && noLevelsState}

      <LibraryToolbar
        urlState={urlState}
        levels={levels}
        focusGroups={focusGroups}
        activeLevel={validLevel}
        activeCategory={validCategory}
        activeType={validType}
        activeVisibility={validVisibility}
        activeFilterCount={activeFilters.length}
        visibilityLabel={visibilityLabel}
        archivedCount={archivedCount}
        total={total}
        showFilters={!emptyLibrary}
      />

      {emptyLibrary ? (
        levels.length > 0 && emptyLibraryState
      ) : items.length === 0 ? (
        view === "archived" ? (
          <EmptyState
            icon={Archive}
            title={t("web.materials.noArchivedTitle")}
            description={t("web.materials.noArchivedBody")}
          />
        ) : anyFilter ? (
          <EmptyState
            icon={FilterX}
            title={t("web.materials.noResultsTitle")}
            description={t("web.materials.noResultsBody")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={materialsClearFiltersHref(urlState)}>
                  {t("web.materials.clearFilters")}
                </Link>
              </Button>
            }
          />
        ) : mode.kind === "level" ? (
          // An empty LEVEL, not an empty library — the library has materials,
          // they are filed elsewhere. Saying "your library is empty" here
          // (which it did) sends a teacher looking for materials she can see
          // one click away.
          <EmptyState
            icon={Layers}
            title={t("web.materials.emptyShelfTitle")}
            description={t("web.materials.emptyShelfBody")}
            action={addMaterial}
          />
        ) : (
          // The flat list, unfiltered, with nothing on it — so everything she
          // has is on the archived shelf.
          <EmptyState
            icon={Archive}
            title={t("web.materials.allArchivedTitle")}
            description={t("web.materials.allArchivedBody")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={materialsHref(urlState, { view: "archived" })}>
                  {t("web.materials.seeArchived")}
                </Link>
              </Button>
            }
          />
        )
      ) : (
        <>
          {/* The list's own heading. Never shown — the selected shelf chip
              already says which shelf this is on screen — but it keeps the
              outline h1 (page) - h2 (shelf) - h3 (material) rather than
              jumping from the page title straight to a row, and gives a
              screen reader a landmark to skip the toolbar with. */}
          <h2 className="sr-only">
            {mode.kind === "level"
              ? (levelLabel.get(mode.levelId) ?? t("web.materials.pageTitle"))
              : t("web.materials.allLevels")}
          </h2>
          <ul className="space-y-3">
            {items.map((m) => (
              <MaterialCard
                key={m.id}
                material={m}
                levelLabel={levelLabel.get(m.levelId ?? "") ?? null}
                visibilityLabel={visibilityLabel(m.visibility)}
                view={view}
                levels={levelOptions}
                focusGroups={focusGroups}
                templates={templates}
                aiEnabled={aiEnabled}
                isPro={isPro}
                podcastEnabled={podcastEnabled}
                dateLabel={addedFormatter.format(m.createdAt)}
              />
            ))}
          </ul>

          <Pagination
            state={pageState}
            params={pageParams}
            labels={{
              showing: t("common.pagination.showing"),
              of: t("common.pagination.of"),
              noResults: t("common.pagination.noResults"),
              page: t("common.pagination.page"),
              prev: t("common.pagination.prev"),
              next: t("common.pagination.next"),
            }}
          />
        </>
      )}
    </PageShell>
  );
}
