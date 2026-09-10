import Link from "next/link";
import { Archive, CheckCircle2, SearchX, Users } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GlanceRow } from "@/components/ui/glance-row";
import { CopyLinkButton } from "@/components/copy-link-button";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { classesLeftToTeach } from "@/lib/package-usage";
import { findRosterDuplicates } from "@/lib/students/duplicates";
import {
  compareRoster,
  matchesStudentSearch,
  needsAttention,
  normalizeStudentSearch,
  resolveStudentScope,
  resolveStudentSort,
  rosterFlags,
  studentsHref,
  type RosterStudent,
  type StudentScope,
  type StudentSort,
} from "@/lib/students-list";
import { RosterList } from "./roster-list";
import { RosterListHeader, RosterToolbar } from "./roster-toolbar";
import {
  DuplicateMergeCard,
  type DuplicatePairDisplay,
  type DuplicateSide,
} from "./duplicate-merge-card";

/**
 * The teacher's roster.
 *
 * The screen answers, in this order, the three questions a teacher opens it
 * with: who needs something from me, where is one particular student, and how
 * is the book of work overall. The previous version answered none of them — it
 * was an unsorted, unsearchable, unfiltered list of every student she has ever
 * had, newest first, with every fact on a row rendered at the same size.
 *
 * FOUR THINGS ABOUT THE SHAPE, since each is a decision rather than a default:
 *
 *  1. "NEEDS ATTENTION" IS A VIEW, not a colour. The signals a teacher actually
 *     acts on — a package that has run out, one expiring inside a fortnight, a
 *     student with credit and nothing booked, one still staged and never
 *     introduced — were all derivable from data this page already loaded and
 *     none of them were shown. See lib/students-list.ts; the count is on the
 *     tab, so it is a to-do list rather than something she has to go looking
 *     for.
 *  2. SEARCH IS IN MEMORY, and deliberately. A Prisma `contains` filter folds
 *     case and nothing else, so on a roster of Lópezes and Peñas the obvious
 *     server-side search silently returns nothing for the people it is for.
 *     The roster is tens of rows.
 *  3. THE SEARCH NARROWS THE LIST, NOT THE PAGE — the rule the class list
 *     already follows. The aside's figures and the tab counts are standing
 *     facts about her roster; recomputing them under a search would report
 *     "Needs attention 0" for a search that matched nobody, which is a
 *     different claim from the true one.
 *  4. TWO COLUMNS above `lg`, for the same reason the class list has them: the
 *     roster is the work and the figures are things she checks, and a list in
 *     a 672px column with 380px of gutter on each side of a 1440px screen is
 *     not a layout decision anyone made.
 *
 * Tenancy: every query is filtered by `teacherId` from auth.
 */

/**
 * The roster's ceiling. Generous enough that no real teacher reaches it — the
 * product's largest roster is two orders of magnitude below — and the page
 * says so rather than truncating silently if one ever does. It exists because
 * ordering and searching happen in memory, so "all of them" has to mean a
 * number rather than whatever the database holds.
 */
const ROSTER_LIMIT = 500;

export default async function TeacherStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [teacher, locale, t, params] = await Promise.all([
    requireOnboardedTeacher(),
    getPreferredLocale(),
    getT(),
    searchParams,
  ]);

  const scope = resolveStudentScope(params.show);
  const sort = resolveStudentSort(params.sort);
  const search = normalizeStudentSearch(params.q);
  const now = new Date();
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const bookingUrl = `${appUrl}/b/${teacher.bookingSlug}`;

  const links = await prisma.teacherStudent.findMany({
    where: { teacherId: teacher.id },
    orderBy: { createdAt: "desc" },
    take: ROSTER_LIMIT + 1,
    // Level, student and the student's newest active package are three
    // relation round trips per request under Prisma's default strategy,
    // whatever the roster size; `join` makes it one. The only to-many here is
    // capped at `take: 1`, so there is no fanout.
    relationLoadStrategy: "join",
    include: {
      level: { select: { label: true } },
      // Grandfathering is per package, so the roster chip counts agreed
      // prices rather than showing the one number there used to be.
      _count: { select: { templatePrices: true } },
      student: {
        select: {
          id: true,
          name: true,
          email: true,
          phoneE164: true,
          authUserId: true,
          createdAt: true,
          // ACTIVE ONLY, AND ONE. This used to load every package the student
          // has ever bought from this teacher, in full, to find the one active
          // row — so a long-standing student cost thirty rows per render and a
          // roster of forty cost twelve hundred.
          packages: {
            where: { teacherId: teacher.id, status: "active" },
            orderBy: { purchasedAt: "desc" },
            take: 1,
            select: {
              id: true,
              classesTotal: true,
              classesUsed: true,
              expiresAt: true,
            },
          },
        },
      },
    },
  });

  const capped = links.length > ROSTER_LIMIT;
  const rows = capped ? links.slice(0, ROSTER_LIMIT) : links;

  // Duplicate hint: scan the whole roster (a typo'd twin may sit archived) and
  // pre-pick the surviving side — login beats packages beats age — so the
  // teacher only confirms. The merge action re-validates everything.
  const duplicatePairs = findRosterDuplicates(
    rows.map((l) => ({
      studentId: l.student.id,
      email: l.student.email,
      phoneE164: l.student.phoneE164,
    })),
  );
  const duplicateIds = [...new Set(duplicatePairs.flatMap((p) => [p.aId, p.bId]))];

  const activePackageIds = rows
    .map((l) => l.student.packages[0]?.id)
    .filter((id): id is string => id != null);

  const [scheduledCounts, upcomingCounts, duplicatePackageCounts] = await Promise.all([
    // "Classes left to teach" (see package-usage.ts) needs the count of
    // still-scheduled bookings per active package. One grouped query covers
    // them all, so no two surfaces can report different numbers.
    activePackageIds.length
      ? prisma.booking.groupBy({
          by: ["packageId"],
          where: {
            teacherId: teacher.id,
            packageId: { in: activePackageIds },
            status: "scheduled",
          },
          _count: { _all: true },
        })
      : [],
    // Which students have a class still ahead of them. A student holding
    // credit with nothing on the calendar is the quietest way a teacher loses
    // one, and it was not visible anywhere in the product.
    prisma.booking.groupBy({
      by: ["studentId"],
      where: { teacherId: teacher.id, status: "scheduled", scheduledEnd: { gte: now } },
      _count: { _all: true },
    }),
    // Only for the students in a duplicate pair, and only when there are any —
    // the roster query no longer loads a student's whole purchase history, and
    // this is the one place that count is still read.
    duplicateIds.length
      ? prisma.package.groupBy({
          by: ["studentId"],
          where: { teacherId: teacher.id, studentId: { in: duplicateIds } },
          _count: { _all: true },
        })
      : [],
  ]);

  const scheduledByPackage = new Map(scheduledCounts.map((r) => [r.packageId, r._count._all]));
  const hasUpcoming = new Set(upcomingCounts.map((r) => r.studentId));
  const packagesByStudent = new Map(
    duplicatePackageCounts.map((r) => [r.studentId, r._count._all]),
  );

  const roster: RosterStudent[] = rows.map((l) => {
    const active = l.student.packages[0];
    return {
      studentId: l.student.id,
      name: l.student.name,
      email: l.student.email,
      phoneE164: l.student.phoneE164,
      linkedAt: l.createdAt,
      archived: l.archivedAt != null,
      notLive: l.onboardingHoldAt != null,
      levelLabel: l.level?.label ?? null,
      agreedPriceCount: l._count.templatePrices,
      activePackage: active
        ? {
            total: active.classesTotal,
            left: classesLeftToTeach({
              classesTotal: active.classesTotal,
              classesUsed: active.classesUsed,
              scheduled: scheduledByPackage.get(active.id) ?? 0,
            }),
            expiresAt: active.expiresAt,
          }
        : null,
      hasUpcomingClass: hasUpcoming.has(l.student.id),
    };
  });

  const studentById = new Map(rows.map((l) => [l.student.id, l.student]));
  const toSide = (id: string): DuplicateSide => {
    const s = studentById.get(id)!;
    return {
      id: s.id,
      name: s.name,
      email: s.email,
      hasLogin: s.authUserId != null,
      packageCount: packagesByStudent.get(s.id) ?? 0,
    };
  };
  const duplicateDisplay: DuplicatePairDisplay[] = duplicatePairs.map((pair) => {
    const a = toSide(pair.aId);
    const b = toSide(pair.bId);
    const aWins =
      a.hasLogin !== b.hasLogin
        ? a.hasLogin
        : a.packageCount !== b.packageCount
          ? a.packageCount > b.packageCount
          : studentById.get(a.id)!.createdAt <= studentById.get(b.id)!.createdAt;
    return aWins
      ? { keep: a, merge: b, reason: pair.reason }
      : { keep: b, merge: a, reason: pair.reason };
  });

  // The standing figures, over the whole roster rather than the current view —
  // see note 3 in the header comment.
  const active = roster.filter((s) => !s.archived);
  const archivedCount = roster.length - active.length;
  const attention = active.filter((s) => needsAttention(rosterFlags(s, now, teacher.timezone)));
  const classesLeft = active.reduce((sum, s) => sum + (s.activePackage?.left ?? 0), 0);

  const inScope =
    scope === "archived"
      ? roster.filter((s) => s.archived)
      : scope === "attention"
        ? attention
        : active;
  const visible = inScope
    .filter((s) => matchesStudentSearch(s, search))
    .sort(compareRoster(sort, locale));

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("web.dashboard.students.title")}
        description={t("web.dashboard.students.subtitle")}
        actions={
          <>
            <Button asChild>
              <Link href="/dashboard/students/new">
                {t("web.dashboard.students.new.addStudent")}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/students/invitations">
                {t("web.dashboard.invitations.manageLink")}
              </Link>
            </Button>
          </>
        }
      />

      {roster.length === 0 ? (
        /* One column, not two: an aside of zeroes beside "you have no students"
           is furniture, and the only useful thing on the screen at this moment
           is the link that gets her one. */
        <EmptyState
          icon={Users}
          title={t("web.dashboard.students.empty.title")}
          description={t("web.dashboard.students.empty.description")}
          action={
            <div className="mt-2 flex w-full max-w-reading flex-col items-center gap-3">
              <Button asChild>
                <Link href="/dashboard/students/new">
                  {t("web.dashboard.students.new.addStudent")}
                </Link>
              </Button>
              <p className="text-sm text-muted-foreground">
                {t("web.dashboard.students.roster.shareLinkLabel")}
              </p>
              <div className="w-full rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm break-all">
                {bookingUrl}
              </div>
              <CopyLinkButton value={bookingUrl} />
            </div>
          }
        />
      ) : (
        /* `items-start` so a short aside does not stretch to the list's height
           and leave its card floating in whitespace. */
        <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
          <div className="space-y-4 lg:col-span-2">
            {/* Above the toolbar: it is the one thing on this screen that is
                wrong rather than merely unfinished, and it is dismissed by
                acting on it. */}
            <DuplicateMergeCard pairs={duplicateDisplay} />

            <RosterToolbar
              scope={scope}
              search={search}
              sort={sort}
              attentionCount={attention.length}
              t={t}
            />

            {visible.length === 0 ? (
              <ListEmptyState scope={scope} search={search} sort={sort} t={t} />
            ) : (
              <Card className="overflow-hidden">
                <RosterListHeader
                  scope={scope}
                  search={search}
                  sort={sort}
                  count={visible.length}
                  t={t}
                />
                <RosterList students={visible} now={now} timezone={teacher.timezone} t={t} />
              </Card>
            )}

            {/* Outside the card, so it is still said when the list is empty:
                past the ceiling, a search that finds nobody has only searched
                as far as the ceiling, and silence there would be a wrong answer
                rather than a partial one. */}
            {capped && (
              <p className="text-sm text-muted-foreground">
                {t("web.dashboard.students.roster.capped", { limit: ROSTER_LIMIT })}
              </p>
            )}
          </div>

          <aside className="space-y-6">
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-lg" as="h2">
                  {t("web.dashboard.students.roster.glance.title")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <GlanceRow
                    label={t("web.dashboard.students.roster.glance.active")}
                    value={active.length}
                  />
                  <GlanceRow
                    label={t("web.dashboard.students.roster.glance.attention")}
                    value={attention.length}
                    tone="warning"
                    /* Carries the order but NOT the search: these are figures
                       about the whole roster, so the view they open has to be
                       too, or the number and the list it leads to disagree. */
                    href={studentsHref("attention", { sort })}
                  />
                  <GlanceRow
                    label={t("web.dashboard.students.roster.glance.classesLeft")}
                    value={classesLeft}
                  />
                  {archivedCount > 0 && (
                    <GlanceRow
                      label={t("web.dashboard.students.roster.glance.archived")}
                      value={archivedCount}
                      href={studentsHref("archived", { sort })}
                    />
                  )}
                </dl>
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
    </PageShell>
  );
}

/**
 * The four ways this list can be empty, each said in its own words.
 *
 * A search that found nothing is not the same event as a view with nothing in
 * it, and "No students" under a search for "Marcela" reads as data loss rather
 * than as a filter. "Needs attention: empty" is the only one of the four that
 * is good news, and it says so.
 */
function ListEmptyState({
  scope,
  search,
  sort,
  t,
}: {
  scope: StudentScope;
  search: string;
  sort: StudentSort;
  t: TFunction;
}) {
  if (search) {
    return (
      <EmptyState
        icon={SearchX}
        title={t("web.dashboard.students.roster.empty.searchTitle", { query: search })}
        description={t("web.dashboard.students.roster.empty.searchBody")}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={studentsHref(scope, { sort })}>
              {t("web.dashboard.students.roster.search.clear")}
            </Link>
          </Button>
        }
      />
    );
  }

  if (scope === "attention") {
    return (
      <EmptyState
        icon={CheckCircle2}
        title={t("web.dashboard.students.roster.empty.attentionTitle")}
        description={t("web.dashboard.students.roster.empty.attentionBody")}
      />
    );
  }

  if (scope === "archived") {
    return (
      <EmptyState
        icon={Archive}
        title={t("web.dashboard.students.roster.empty.archivedTitle")}
        description={t("web.dashboard.students.roster.empty.archivedBody")}
      />
    );
  }

  // The active view is empty but the roster is not — everyone is archived.
  return (
    <EmptyState
      icon={Users}
      title={t("web.dashboard.students.roster.empty.allArchivedTitle")}
      description={t("web.dashboard.students.roster.empty.allArchivedBody")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href={studentsHref("archived", { sort })}>
            {t("web.dashboard.students.roster.scope.archived")}
          </Link>
        </Button>
      }
    />
  );
}
