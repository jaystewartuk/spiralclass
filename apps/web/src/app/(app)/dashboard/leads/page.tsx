import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Archive, Inbox, Megaphone, SearchX, UserRoundCheck } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyLinkButton } from "@/components/copy-link-button";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getPublicFunnelT, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import type { TFunction } from "@/lib/i18n-translate";
import {
  conversionRate,
  LEAD_SCOPE_STATUSES,
  leadsHref,
  normalizeLeadSearch,
  resolveLeadScope,
  type LeadScope,
} from "@/lib/leads/list";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/leads/status";
import { LeadGroup, type LeadContext, type LeadItem } from "./lead-list";
import { LeadsToolbar } from "./leads-toolbar";

/**
 * Inbound enquiries from the public booking page.
 *
 * The screen answers one question — WHO AM I YET TO ANSWER — and it now
 * answers it in the first screenful. What it replaced was a single flat list,
 * newest first, in which a five-minute-old enquiry and a lead converted three
 * months ago were the same object at the same weight, with the same solid
 * "Mark converted" button on each; the only structure was an "Archivado"
 * heading two thirds of the way down.
 *
 * FOUR DECISIONS, since each is a choice rather than a default:
 *
 *  1. THREE VIEWS AT THEIR OWN URLS. Open (unanswered plus in-conversation),
 *     the ones who became students, and the archive. Links rather than a tab
 *     widget, for the reasons in `leads-toolbar.tsx`.
 *  2. THE OPEN VIEW IS TWO HEADED GROUPS. "Needs a reply" and "In
 *     conversation" are different jobs — one is hers, the other is the other
 *     person's — and the split is what turns a list into a queue.
 *  3. THE ORDER STAYS NEWEST FIRST; THE AGE ESCALATES INSTEAD. Sorting the
 *     queue oldest-first would bury the enquiry most likely to still convert
 *     under one that has already gone cold. See `replyUrgency` in
 *     lib/leads/list.ts.
 *  4. THE ASIDE IS THE FUNNEL, NOT DECORATION. Three numbers and, once there
 *     are enough leads for it to mean anything, the rate. This is where a
 *     teacher finds out whether her booking page works, and the numbers are
 *     links into the views they count.
 *
 * Tenancy: every query is filtered by `teacherId` from auth.
 */

/**
 * The list's ceiling. Generous enough that no real teacher reaches it, and the
 * page says so rather than truncating silently when one does.
 */
const LIST_LIMIT = 100;

const LEAD_SELECT = {
  id: true,
  name: true,
  email: true,
  phoneE164: true,
  message: true,
  status: true,
  createdAt: true,
} satisfies Prisma.LeadSelect;

export default async function LeadsPage({
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

  const scope = resolveLeadScope(params.show);
  const search = normalizeLeadSearch(params.q);
  const now = new Date();

  const mine = { teacherId: teacher.id };
  // THE SEARCH NARROWS THE LIST, NOT THE PAGE — the same rule the class list
  // follows. The tab count and the funnel in the aside are standing facts
  // about her enquiries; recomputing them under a search would report
  // "Became students 0" for a name that simply is not in this scope, which is
  // a different claim from the true one.
  //
  // The phone clause searches DIGITS. A teacher who pastes "+52 55 1234 5678"
  // out of her own phone book would otherwise match nothing, because the
  // column holds E.164 with no separators.
  const digits = search.replace(/\D/g, "");
  const searched: Prisma.LeadWhereInput = search
    ? {
        ...mine,
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { message: { contains: search, mode: "insensitive" } },
          ...(digits ? [{ phoneE164: { contains: digits } }] : []),
        ],
      }
    : mine;

  const [rows, statusCounts] = await Promise.all([
    // One row over the ceiling, so "there are more" is something the page
    // knows rather than something it infers from a full page of results.
    prisma.lead.findMany({
      where: { ...searched, status: { in: [...LEAD_SCOPE_STATUSES[scope]] } },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT + 1,
      select: LEAD_SELECT,
    }),
    // All four counts in one round trip, off the `[teacherId, status,
    // createdAt]` index the table already carries.
    prisma.lead.groupBy({ by: ["status"], where: mine, _count: { _all: true } }),
  ]);

  const countByStatus = new Map(statusCounts.map((row) => [row.status, row._count._all]));
  const countOf = (status: LeadStatus) => countByStatus.get(status) ?? 0;
  const totalLeads = LEAD_STATUSES.reduce((sum, status) => sum + countOf(status), 0);
  const openCount = countOf("new") + countOf("contacted");
  const rate = conversionRate(countOf("converted"), totalLeads);

  const hasMore = rows.length > LIST_LIMIT;
  const items: LeadItem[] = rows.slice(0, LIST_LIMIT);

  const ctx: LeadContext = {
    t,
    locale,
    timezone: teacher.timezone,
    now,
    // The reply goes to someone who read her BOOKING PAGE, not her dashboard,
    // and those are allowed to be different languages — the whole point of
    // `booking_page_locale` (D-73's lesson, applied a fourth time). Her own
    // UI locale would put a Spanish subject line in front of the English
    // speakers the platform's one Mexican teacher actually sells to.
    replySubject: getPublicFunnelT(teacher.bookingPageLocale)("web.dashboard.leads.replySubject"),
  };

  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const bookingUrl = `${appUrl}/b/${teacher.bookingSlug}`;

  // The first-run screen. Not the list with an empty-state card dropped into
  // it: with no leads at all there is nothing to filter, nothing to count and
  // nothing to compare, so a toolbar and a funnel of zeroes would be three
  // controls acting on nothing. The one thing that helps is the link that
  // produces leads, so that is the whole screen.
  if (totalLeads === 0) {
    return (
      <PageShell width="default">
        <PageHeader
          title={t("web.dashboard.leads.title")}
          description={t("web.dashboard.leads.subtitle")}
        />
        <EmptyState
          icon={Inbox}
          title={t("web.dashboard.leads.emptyNoneTitle")}
          description={t("web.dashboard.leads.noneYet")}
          action={
            <div className="flex w-full max-w-prose flex-col items-center gap-3">
              <div className="bg-muted/40 w-full rounded-md border px-3 py-2 font-mono text-xs break-all">
                {bookingUrl}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <CopyLinkButton value={bookingUrl} />
                <Button asChild variant="ghost" size="sm">
                  <Link href="/dashboard/get-students">{t("web.dashboard.leads.sharePlan")}</Link>
                </Button>
              </div>
            </div>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("web.dashboard.leads.title")}
        description={t("web.dashboard.leads.subtitle")}
      />

      {/* `items-start` so a short aside does not stretch to the list's height
          and leave its last card floating in whitespace. */}
      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-4 lg:col-span-2">
          <LeadsToolbar scope={scope} search={search} openCount={openCount} t={t} />

          {items.length === 0 ? (
            <ListEmptyState scope={scope} search={search} t={t} />
          ) : scope === "open" ? (
            <>
              <LeadGroup
                title={t("web.dashboard.leads.needsReply")}
                description={t("web.dashboard.leads.needsReplyHelp")}
                leads={items.filter((lead) => lead.status === "new")}
                ctx={ctx}
              />
              <LeadGroup
                title={t("web.dashboard.leads.inConversation")}
                description={t("web.dashboard.leads.inConversationHelp")}
                leads={items.filter((lead) => lead.status === "contacted")}
                ctx={ctx}
              />
            </>
          ) : (
            <LeadGroup leads={items} ctx={ctx} />
          )}

          {hasMore && (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.leads.showingRecent", { count: LIST_LIMIT })}
            </p>
          )}
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg" as="h2">
                {t("web.dashboard.leads.funnelTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="space-y-3">
                <FunnelRow
                  label={t("web.dashboard.leads.funnelWaiting")}
                  value={countOf("new")}
                  href={leadsHref("open")}
                  tone={countOf("new") > 0 ? "attention" : "default"}
                />
                <FunnelRow
                  label={t("web.dashboard.leads.funnelInConversation")}
                  value={countOf("contacted")}
                  href={leadsHref("open")}
                />
                <FunnelRow
                  label={t("web.dashboard.leads.funnelConverted")}
                  value={countOf("converted")}
                  href={leadsHref("converted")}
                />
              </dl>
              {/* Only once there are enough leads for a percentage to be a
                  measurement rather than a coin flip — see
                  CONVERSION_RATE_MIN_LEADS. */}
              {rate !== null && (
                <p className="text-muted-foreground border-t pt-3 text-sm">
                  {t("web.dashboard.leads.funnelRate", { percent: rate })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg" as="h2">
                {t("web.dashboard.leads.shareTitle")}
              </CardTitle>
              <CardDescription>{t("web.dashboard.leads.shareBody")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-xs break-all">
                {bookingUrl}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CopyLinkButton value={bookingUrl} />
                <Button asChild variant="ghost" size="sm">
                  <Link href="/dashboard/get-students">{t("web.dashboard.leads.sharePlan")}</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

/** One line of the funnel: a label, a number, and the view that number counts. */
function FunnelRow({
  label,
  value,
  href,
  tone = "default",
}: {
  label: string;
  value: number;
  href: string;
  tone?: "default" | "attention";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-sm">
        <Link href={href} className="hover:text-foreground underline-offset-4 hover:underline">
          {label}
        </Link>
      </dt>
      <dd className={tone === "attention" ? "text-primary font-semibold" : "font-semibold"}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The four ways this list can be empty, each said in its own words.
 *
 * A search that found nothing is not the same event as an archive with nothing
 * in it, and "No open leads" under a search for "Marcela" reads as data loss
 * rather than as a filter.
 */
function ListEmptyState({ scope, search, t }: { scope: LeadScope; search: string; t: TFunction }) {
  if (search) {
    return (
      <EmptyState
        icon={SearchX}
        title={t("web.dashboard.leads.emptySearchTitle", { query: search })}
        description={t("web.dashboard.leads.emptySearchBody")}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={leadsHref(scope)}>{t("web.dashboard.leads.searchClear")}</Link>
          </Button>
        }
      />
    );
  }

  if (scope === "converted") {
    return (
      <EmptyState
        icon={UserRoundCheck}
        title={t("web.dashboard.leads.emptyConvertedTitle")}
        description={t("web.dashboard.leads.emptyConvertedBody")}
      />
    );
  }

  if (scope === "archived") {
    return (
      <EmptyState
        icon={Archive}
        title={t("web.dashboard.leads.emptyArchivedTitle")}
        description={t("web.dashboard.leads.emptyArchivedBody")}
      />
    );
  }

  return (
    <EmptyState
      icon={Megaphone}
      title={t("web.dashboard.leads.emptyOpenTitle")}
      description={t("web.dashboard.leads.emptyOpenBody")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/get-students">{t("web.dashboard.leads.sharePlan")}</Link>
        </Button>
      }
    />
  );
}
