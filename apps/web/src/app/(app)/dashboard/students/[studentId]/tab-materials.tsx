import Link from "next/link";
import type { Teacher } from "@prisma/client";
import { Check, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { formatZonedDateTime, formatZonedDayHeader } from "@/lib/date-display";
import {
  filterStudentMaterials,
  groupStudentMaterials,
  materialDisplayTitle,
  type StudentMaterialGroup,
  type StudentMaterialItem,
  type StudentMaterialsFilter,
  type StudentMaterialsGroupBy,
} from "@/lib/materials/student-materials";
import { listStudentMaterialHistory } from "@/lib/materials/class-history";
import { getTeacherLevels } from "@/lib/levels";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import {
  setLibraryItemCompletedAction,
  unassignLibraryMaterialAction,
} from "@/app/actions/library";
import { AssignMaterialForm } from "./assign-material-form";
import { studentDetailHref } from "./student-detail-nav";

/**
 * Everything this student has been given: the reusable library items assigned
 * to her (the notebook — what to cover, and what has been), and the history of
 * what has actually reached her classes.
 *
 * They were two cards four sections apart on the old page, which meant the two
 * halves of one question ("what has she got?") were never on screen together.
 *
 * THE FILTERS NOW SAY WHAT THEY FILTER. There were two identical-looking pill
 * groups above the history with no labels at all: a reader had to click one to
 * learn that the first was a filter and the second a grouping. They are named,
 * and the selected link carries `aria-current` so the state is not carried by
 * a background colour alone.
 */

const FILTERS: readonly StudentMaterialsFilter[] = ["all", "used", "sent"];
const GROUP_BYS: readonly StudentMaterialsGroupBy[] = ["class", "date", "type"];

function timingLabels(
  t: TFunction,
): Record<NonNullable<StudentMaterialItem["sendTiming"]>, string> {
  return {
    confirmation: t("web.dashboard.students.classMaterials.timing.confirmation"),
    t_5d: t("web.dashboard.students.classMaterials.timing.t5d"),
    t_24h: t("web.dashboard.students.classMaterials.timing.t24h"),
    t_1h: t("web.dashboard.students.classMaterials.timing.t1h"),
  };
}

/**
 * A row of links that switch one URL parameter, with a name.
 *
 * `role="group"` and a real label rather than `role="tablist"`: these navigate,
 * and the ARIA tab pattern would promise arrow-key traversal that does not
 * exist here.
 */
function SegmentedLinks<T extends string>({
  id,
  label,
  options,
  current,
  hrefFor,
  labelFor,
}: {
  /** Ties the group to its visible label. Passed in rather than derived from
   *  the label text, which is translated and would produce an `id` with
   *  spaces in it. */
  id: string;
  label: string;
  options: readonly T[];
  current: T;
  hrefFor: (option: T) => string;
  labelFor: (option: T) => string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground" id={id}>
        {label}
      </p>
      <div role="group" aria-labelledby={id} className="flex rounded-md bg-muted p-1">
        {options.map((option) => {
          const active = option === current;
          return (
            <Link
              key={option}
              href={hrefFor(option)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded px-3 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden",
                active
                  ? "bg-background text-foreground shadow-brand-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {labelFor(option)}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export async function MaterialsTab({
  studentId,
  teacher,
  locale,
  t,
  filter,
  groupBy,
}: {
  studentId: string;
  teacher: Teacher;
  locale: AppLocale;
  t: TFunction;
  filter: StudentMaterialsFilter;
  groupBy: StudentMaterialsGroupBy;
}) {
  const [levels, libraryMaterials, assignments, classMaterialItems] = await Promise.all([
    getTeacherLevels(teacher.id),
    // Reusable library items only — a booking-scoped material (bookingId set,
    // D-69) is private to its class and never assignable here.
    prisma.libraryMaterial.findMany({
      where: { teacherId: teacher.id, archived: false, bookingId: null },
      orderBy: [{ levelId: "asc" }, { position: "asc" }],
      select: { id: true, label: true, levelId: true, storagePath: true, linkUrl: true },
    }),
    prisma.studentLibraryItem.findMany({
      where: { teacherId: teacher.id, studentId },
      orderBy: { assignedAt: "desc" },
      select: {
        completedAt: true,
        material: { select: { id: true, label: true, levelId: true, storagePath: true } },
      },
    }),
    // Everything that touched any of this student's classes — her own class
    // materials, library items attached to a class, and anything the teacher
    // opened ON a call. See lib/materials/class-history.ts for why all three
    // sources are needed.
    listStudentMaterialHistory({ teacherId: teacher.id, studentId }),
  ]);

  const levelLabelById = new Map(levels.map((l) => [l.id, l.label]));
  const assignedIds = new Set(assignments.map((a) => a.material.id));
  const assignOptions = libraryMaterials.filter((m) => !assignedIds.has(m.id));
  const coveredCount = assignments.filter((a) => a.completedAt != null).length;

  const materialTitle = (m: {
    label: string | null;
    storagePath: string | null;
    linkUrl?: string | null;
  }) => {
    if (m.label) return m.label;
    if (m.storagePath) return t("web.dashboard.students.material.file");
    if (m.linkUrl) {
      try {
        return new URL(m.linkUrl).hostname.replace(/^www\./, "");
      } catch {
        return t("web.dashboard.students.material.link");
      }
    }
    return t("web.dashboard.students.material.materialLabel");
  };

  const timingLabelsByKey = timingLabels(t);
  const historyTitleFallbacks = {
    content: t("web.dashboard.students.material.classContent"),
    file: t("web.dashboard.students.material.file"),
    link: t("web.dashboard.students.material.link"),
  };

  // Teachers see everything by default (they already do on the single-class
  // Materials panel); "Sent only" narrows to what the student can see right
  // now, and "Used in class" to what was actually opened on a call — the
  // question this section exists to answer.
  const visible = filterStudentMaterials(classMaterialItems, filter);
  const groups = groupStudentMaterials(visible, groupBy, teacher.timezone);

  function groupLabel(group: StudentMaterialGroup): string {
    const first = group.items[0];
    if (groupBy === "class") return formatZonedDateTime(first.classStart, teacher.timezone, locale);
    if (groupBy === "date") return formatZonedDayHeader(first.classStart, teacher.timezone, locale);
    if (group.key === "file") return t("web.dashboard.students.material.files");
    if (group.key === "link") return t("web.dashboard.students.material.links");
    return t("web.dashboard.students.material.contents");
  }

  const filterLabel = (f: StudentMaterialsFilter) =>
    f === "all"
      ? t("web.dashboard.students.classMaterials.filterAll")
      : f === "used"
        ? t("web.dashboard.students.classMaterials.filterUsedOnly")
        : t("web.dashboard.students.classMaterials.filterSentOnly");

  const groupByLabel = (g: StudentMaterialsGroupBy) =>
    g === "class"
      ? t("web.dashboard.students.classMaterials.groupByClass")
      : g === "date"
        ? t("web.dashboard.students.classMaterials.groupByDate")
        : t("web.dashboard.students.classMaterials.groupByType");

  return (
    // The history is the column that grows — one row per material per class,
    // for as long as the student stays — so it takes the two-thirds. The
    // syllabus beside it is a short, stable list, and stacking the two
    // full-width left the assigned rows with a third of a screen of empty
    // space between a title and its buttons.
    <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
      <Card className="lg:order-2">
        <CardHeader className="pb-4">
          <CardTitle className="flex flex-wrap items-baseline gap-x-2 text-lg" as="h2">
            {t("web.dashboard.students.material.assignedTitle")}
            {assignments.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground tabular-nums">
                {t("web.dashboard.students.material.coveredCount", {
                  covered: String(coveredCount),
                  total: String(assignments.length),
                })}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            {t("web.dashboard.students.material.assignedDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {assignments.length > 0 && (
            <ul className="space-y-2">
              {assignments.map((a) => {
                const covered = a.completedAt != null;
                return (
                  <li
                    key={a.material.id}
                    className={cn(
                      "space-y-2 rounded-md border px-3 py-2",
                      // A covered item is done, not gone: it recedes rather
                      // than disappearing, so the list still reads as a
                      // syllabus and not just a to-do queue.
                      covered && "bg-muted/40",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{materialTitle(a.material)}</p>
                      {a.material.levelId && (
                        <p className="text-sm text-muted-foreground">
                          {levelLabelById.get(a.material.levelId) ?? ""}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <form action={setLibraryItemCompletedAction}>
                        <input type="hidden" name="studentId" value={studentId} />
                        <input type="hidden" name="materialId" value={a.material.id} />
                        <input type="hidden" name="completed" value={covered ? "false" : "true"} />
                        <Button type="submit" variant={covered ? "secondary" : "outline"} size="sm">
                          {covered && <Check className="size-4" aria-hidden />}
                          {covered
                            ? t("web.dashboard.students.material.covered")
                            : t("web.dashboard.students.material.markCovered")}
                        </Button>
                      </form>
                      <form action={unassignLibraryMaterialAction}>
                        <input type="hidden" name="studentId" value={studentId} />
                        <input type="hidden" name="materialId" value={a.material.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                        >
                          {t("web.dashboard.students.material.remove")}
                        </Button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {libraryMaterials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("web.dashboard.students.material.addFirstPrefix")}{" "}
              <Link href="/dashboard/materials" className="underline underline-offset-4">
                {t("web.dashboard.students.material.materialsLinkLabel")}
              </Link>{" "}
              {t("web.dashboard.students.material.addFirstSuffix")}
            </p>
          ) : (
            <AssignMaterialForm
              studentId={studentId}
              options={assignOptions.map((m) => ({
                id: m.id,
                // Non-null by construction — the query above scopes to
                // bookingId: null, and a reusable item always has a level.
                label: `${levelLabelById.get(m.levelId!) ?? ""} · ${materialTitle(m)}`,
              }))}
            />
          )}
        </CardContent>
      </Card>

      <Card className="lg:order-1 lg:col-span-2">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg" as="h2">
            {t("web.dashboard.students.section.classMaterials")}
          </CardTitle>
          <CardDescription>
            {t("web.dashboard.students.classMaterials.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            <SegmentedLinks
              id="materials-filter-label"
              label={t("web.dashboard.students.classMaterials.showLabel")}
              options={FILTERS}
              current={filter}
              hrefFor={(f) => studentDetailHref(studentId, "materials", { filter: f, groupBy })}
              labelFor={filterLabel}
            />
            <SegmentedLinks
              id="materials-group-label"
              label={t("web.dashboard.students.classMaterials.groupLabel")}
              options={GROUP_BYS}
              current={groupBy}
              hrefFor={(g) => studentDetailHref(studentId, "materials", { filter, groupBy: g })}
              labelFor={groupByLabel}
            />
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filter === "sent"
                ? t("web.dashboard.students.classMaterials.noneSentYet")
                : filter === "used"
                  ? t("web.dashboard.students.classMaterials.noneUsedYet")
                  : t("web.dashboard.students.classMaterials.noneYet")}
            </p>
          ) : (
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.key} className="space-y-2">
                  <h3
                    data-class-material-group
                    className="border-b pb-1 text-sm font-semibold text-muted-foreground"
                  >
                    {groupLabel(group)}
                  </h3>
                  <ul className="space-y-2">
                    {group.items.map((m) => {
                      const title = materialDisplayTitle(m, historyTitleFallbacks);
                      return (
                        <li
                          key={m.id}
                          className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-md border px-3 py-2"
                        >
                          <div className="min-w-0 flex-1 basis-48 space-y-0.5">
                            {/* A file/link opens the document itself; native
                                content has no external URL and is read on the
                                class page, which is where a history row wants
                                to land anyway. */}
                            <a
                              href={m.viewUrl ?? m.href}
                              {...(m.viewUrl ? { target: "_blank", rel: "noreferrer" } : {})}
                              className="inline-flex items-center gap-1.5 font-medium underline underline-offset-4 hover:text-primary"
                            >
                              {title}
                              {m.viewUrl && (
                                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                              )}
                            </a>
                            <p className="text-sm text-muted-foreground">
                              {formatZonedDateTime(m.classStart, teacher.timezone, locale)}
                              {m.sendTiming ? ` · ${timingLabelsByKey[m.sendTiming]}` : ""}
                              {m.origin === "library"
                                ? ` · ${t("web.dashboard.students.classMaterials.fromLibrary")}`
                                : ""}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap justify-end gap-1">
                            {/* "Used" is the fact this section exists for, so
                                it leads; a class routinely prepares more
                                material than it gets through. */}
                            {m.usedInClass && (
                              <Badge variant="secondary">
                                {t("web.dashboard.students.classMaterials.usedInClass")}
                              </Badge>
                            )}
                            <Badge variant={m.sent ? "success" : "warning"}>
                              {m.sent
                                ? t("web.dashboard.students.classMaterials.sent")
                                : t("web.dashboard.students.package.status.pending")}
                            </Badge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
