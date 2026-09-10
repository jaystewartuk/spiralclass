"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { DebouncedSearchInput } from "@/components/ui/debounced-search";
import { FilterBar, FilterField, FilterSelect } from "@/components/ui/filter-bar";
import { RowLink, TableShell } from "@/components/ui/table";
import { matchesTeacherFilters } from "@/lib/admin-filters";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";
import type { PayoutInstrumentKind } from "@spiralclass/shared";

// Columns the server can also sort (mirrors admin/teachers/page.tsx's
// `SORT_COLUMNS` whitelist) — changing one of these debounce-submits the
// enclosing form in the background so cross-page ordering and reloads stay
// correct. Every other column still sorts instantly, it just only reorders
// the rows already on this page (see the data-table.tsx doc comment).
const SERVER_SORTABLE = new Set(["name", "students", "packages", "bookings", "joined"]);

export type TeacherRow = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  onboardingCompleteAt: Date | null;
  disabledAt: Date | null;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  pricingCurrency: string;
  // Marketplace-readiness sub-signals, for the "stalled" filter (onboarding
  // activation audit).
  photoPath: string | null;
  bio: string | null;
  templatesTouchedAt: Date | null;
  availabilityTouchedAt: Date | null;
  // D-113: the payout rail, plus the Wise auto-reconcile credential that moved
  // onto the instrument with it. `schemeId`/`details` were here until D-145
  // dropped the bank_account kind they described.
  payoutInstruments: {
    kind: PayoutInstrumentKind;
    enabled: boolean;
    wiseHandle: string | null;
    wiseApiProfileId: string | null;
  }[];
  _count: { bookings: number; packages: number; teacherStudents: number };
};

function wiseApiConnected(row: Pick<TeacherRow, "payoutInstruments">): boolean {
  return row.payoutInstruments.some((i) => i.kind === "wise" && i.wiseApiProfileId !== null);
}

type Filters = { q: string; onboarded: string; disabled: string; stalled: string };

function filtersFromParams(params: {
  q?: string;
  onboarded?: string;
  disabled?: string;
  stalled?: string;
}): Filters {
  return {
    q: params.q ?? "",
    onboarded: params.onboarded ?? "",
    disabled: params.disabled ?? "",
    stalled: params.stalled ?? "",
  };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "joined", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function TeachersTable({
  initialTeachers,
  params,
}: {
  initialTeachers: TeacherRow[];
  params: {
    q?: string;
    onboarded?: string;
    disabled?: string;
    stalled?: string;
    sort?: string;
    dir?: string;
  };
}) {
  const t = useT();
  const formRef = useRef<HTMLFormElement>(null);
  const scheduleSubmit = useDebouncedSubmit(0);

  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(params));
  const [sort, setSort] = useState<SortState>(() => sortFromParams(params));

  // Re-baseline when the server sends rows for a genuinely different query
  // than the one we're tracking — browser back/forward, the Reset link, or
  // Prev/Next — rather than the round-trip our own debounced submit caused
  // (that one already matches our local state, so this is a no-op then).
  useEffect(() => {
    setFilters(filtersFromParams(params));
    setSort(sortFromParams(params));
  }, [params]);

  const visibleTeachers = useMemo(
    () => initialTeachers.filter((row) => matchesTeacherFilters(row, filters)),
    [initialTeachers, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<TeacherRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.name,
        header: t("web.admin.teachers.colTeacher"),
        meta: { label: t("web.admin.teachers.colTeacher"), sortable: true },
        cell: ({ row }) => (
          <RowLink href={`/admin/teachers/${row.original.id}`}>
            <div className="font-medium">
              {row.original.name}
              {row.original.disabledAt ? (
                <Badge variant="destructive" className="ml-2">
                  {t("web.admin.disabledBadge")}
                </Badge>
              ) : null}
            </div>
            <div className="text-muted-foreground text-xs">{row.original.email}</div>
          </RowLink>
        ),
      },
      {
        id: "onboarded",
        accessorFn: (row) => (row.onboardingCompleteAt ? 1 : 0),
        header: t("web.admin.teachers.onboardedLabel"),
        meta: { label: t("web.admin.teachers.onboardedLabel"), sortable: true },
        cell: ({ row }) =>
          row.original.onboardingCompleteAt ? (
            <Badge variant="success">{t("web.admin.yes")}</Badge>
          ) : (
            <Badge variant="warning">{t("web.admin.teachers.pending")}</Badge>
          ),
      },
      {
        id: "stripe",
        accessorFn: (row) =>
          row.stripeChargesEnabled && row.stripePayoutsEnabled ? 2 : row.stripeAccountId ? 1 : 0,
        header: t("web.admin.teachers.colStripe"),
        meta: { label: t("web.admin.teachers.colStripe"), sortable: true },
        cell: ({ row }) => (
          <>
            {row.original.stripeChargesEnabled && row.original.stripePayoutsEnabled ? (
              <Badge variant="success">{t("web.admin.connected")}</Badge>
            ) : row.original.stripeAccountId ? (
              <Badge variant="warning">{t("web.admin.teachers.pending")}</Badge>
            ) : (
              <Badge variant="outline">{t("web.admin.teachers.notConnected")}</Badge>
            )}
            <div className="text-muted-foreground mt-1 text-xs">
              {row.original.stripeChargesEnabled ? t("web.admin.teachers.charges") : "—"}
              {" / "}
              {row.original.stripePayoutsEnabled ? t("web.admin.teachers.payouts") : "—"}
            </div>
          </>
        ),
      },
      {
        // "Wise API connected" — the auto-reconcile credential, which lives on
        // the Wise instrument since D-113. Still Wise-specific on purpose:
        // SPEI has no statement API to connect to.
        id: "wise",
        accessorFn: (row) => (wiseApiConnected(row) ? 1 : 0),
        header: t("web.admin.teachers.wiseLabel"),
        meta: { label: t("web.admin.teachers.wiseLabel"), sortable: true },
        cell: ({ row }) =>
          wiseApiConnected(row.original) ? (
            <Badge variant="success">{t("web.admin.connected")}</Badge>
          ) : (
            <Badge variant="outline">{t("web.admin.teachers.notConnected")}</Badge>
          ),
      },
      {
        id: "students",
        accessorFn: (row) => row._count.teacherStudents,
        header: t("web.admin.teachers.studentsLabel"),
        meta: { label: t("web.admin.teachers.studentsLabel"), sortable: true },
        cell: ({ row }) => row.original._count.teacherStudents,
      },
      {
        id: "packages",
        accessorFn: (row) => row._count.packages,
        header: t("web.admin.teachers.colPackages"),
        meta: { label: t("web.admin.teachers.colPackages"), sortable: true },
        cell: ({ row }) => row.original._count.packages,
      },
      {
        id: "bookings",
        accessorFn: (row) => row._count.bookings,
        header: t("web.admin.teachers.bookingsLabel"),
        meta: { label: t("web.admin.teachers.bookingsLabel"), sortable: true },
        cell: ({ row }) => row.original._count.bookings,
      },
      {
        id: "joined",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.students.colJoined"),
        meta: {
          label: t("web.admin.students.colJoined"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      },
    ],
    [t],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={5} resetHref="/admin/teachers">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
        <FilterField label={t("web.admin.searchNameEmail")} span={2}>
          <DebouncedSearchInput
            name="q"
            defaultValue={filters.q}
            placeholder={t("web.admin.teachers.searchPlaceholder")}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
        </FilterField>
        <FilterSelect
          label={t("web.admin.teachers.onboardedLabel")}
          name="onboarded"
          value={filters.onboarded}
          onValueChange={(v) => setFilters((f) => ({ ...f, onboarded: v }))}
          options={[
            { value: "", label: t("web.admin.all") },
            { value: "yes", label: t("web.admin.yes") },
            { value: "no", label: t("web.admin.no") },
          ]}
        />
        <FilterSelect
          label={t("web.admin.disabledLabel")}
          name="disabled"
          value={filters.disabled}
          onValueChange={(v) => setFilters((f) => ({ ...f, disabled: v }))}
          options={[
            { value: "", label: t("web.admin.all") },
            { value: "yes", label: t("web.admin.yes") },
            { value: "no", label: t("web.admin.no") },
          ]}
        />
        <FilterSelect
          label={t("web.admin.teachers.stalledLabel")}
          name="stalled"
          value={filters.stalled}
          onValueChange={(v) => setFilters((f) => ({ ...f, stalled: v }))}
          options={[
            { value: "", label: t("web.admin.all") },
            { value: "yes", label: t("web.admin.yes") },
          ]}
        />
      </FilterBar>

      {visibleTeachers.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("web.admin.teachers.noneMatched")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visibleTeachers}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}
