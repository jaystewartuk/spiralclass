import "server-only";
import type { AppLocale } from "@spiralclass/shared";
import {
  contentKindLabel,
  deriveObservations,
  EMPTY_FUNNEL,
  isMarketingContentKind,
  type FunnelTotals,
  type Observation,
  type PerformanceRow,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

// The teacher-facing acquisition dashboard's data layer.
//
// Every number here is a count over `acquisition_events`, scoped to one
// teacher. Nothing is modelled, estimated or predicted, and there is no metric
// present only because it was easy: the screen answers one question — what is
// actually getting this teacher students — so impressions, reach and
// engagement rate are deliberately absent (we cannot measure them honestly on
// platforms we do not post to).

export type AcquisitionWindow = 30 | 90 | 365;

type EventRow = {
  kind: "visit" | "enquiry" | "booking" | "purchase";
  source: string | null;
  communityId: string | null;
  activityId: string | null;
  viaReferral: boolean;
  amountMinorUnits: number | null;
};

function bump(totals: FunnelTotals, row: EventRow): FunnelTotals {
  switch (row.kind) {
    case "visit":
      return { ...totals, visits: totals.visits + 1 };
    case "enquiry":
      return { ...totals, enquiries: totals.enquiries + 1 };
    case "booking":
      return { ...totals, bookings: totals.bookings + 1 };
    case "purchase":
      return {
        ...totals,
        students: totals.students + 1,
        revenueMinorUnits: totals.revenueMinorUnits + (row.amountMinorUnits ?? 0),
      };
  }
}

/**
 * Channel key for one event.
 *
 * Referral is its own channel rather than a property of another one: a friend
 * who arrived because an existing student vouched for the teacher did not come
 * "from Facebook" in any sense she can act on.
 */
export function channelKeyFor(row: { source: string | null; viaReferral: boolean }): string {
  if (row.viaReferral) return "referral";
  const s = (row.source ?? "").toLowerCase();
  if (!s) return "direct";
  if (s.includes("facebook") || s === "fb") return "facebook";
  if (s.includes("reddit")) return "reddit";
  if (s.includes("whatsapp") || s === "wa") return "whatsapp";
  if (s.includes("instagram") || s === "ig") return "instagram";
  return s;
}

const CHANNEL_LABELS: Record<string, Record<AppLocale, string>> = {
  facebook: { "es-MX": "Facebook", en: "Facebook", fr: "Facebook" },
  reddit: { "es-MX": "Reddit", en: "Reddit", fr: "Reddit" },
  whatsapp: { "es-MX": "WhatsApp", en: "WhatsApp", fr: "WhatsApp" },
  instagram: { "es-MX": "Instagram", en: "Instagram", fr: "Instagram" },
  referral: { "es-MX": "Recomendaciones", en: "Referrals", fr: "Recommandations" },
  direct: { "es-MX": "Directo", en: "Direct", fr: "Direct" },
};

export function channelLabel(key: string, locale: AppLocale): string {
  return CHANNEL_LABELS[key]?.[locale] ?? key;
}

export type AcquisitionReport = {
  windowDays: AcquisitionWindow;
  overall: FunnelTotals;
  channels: PerformanceRow[];
  communities: PerformanceRow[];
  content: PerformanceRow[];
  untriedCommunityLabels: string[];
  observations: Observation[];
};

/**
 * One pass over the window's events, bucketed three ways. Deliberately one
 * query plus two small lookups rather than six group-bys: a teacher's event
 * volume is small, and a single scan keeps the three breakdowns provably
 * consistent with each other and with the headline totals.
 */
export async function acquisitionReport(input: {
  teacherId: string;
  windowDays?: AcquisitionWindow;
  locale: AppLocale;
}): Promise<AcquisitionReport> {
  const windowDays = input.windowDays ?? 90;
  const since = new Date(Date.now() - windowDays * 86400_000);

  const [events, communities, activities] = await Promise.all([
    prisma.acquisitionEvent.findMany({
      where: { teacherId: input.teacherId, occurredAt: { gte: since } },
      select: {
        kind: true,
        source: true,
        communityId: true,
        activityId: true,
        viaReferral: true,
        amountMinorUnits: true,
      },
      take: 20000,
    }),
    prisma.teacherShareGroup.findMany({
      where: { teacherId: input.teacherId },
      select: { id: true, name: true, archivedAt: true },
    }),
    prisma.marketingActivity.findMany({
      where: { teacherId: input.teacherId },
      select: { id: true, kind: true },
    }),
  ]);

  const communityName = new Map(communities.map((c) => [c.id, c.name]));
  const activityKind = new Map(activities.map((a) => [a.id, a.kind]));

  let overall = EMPTY_FUNNEL;
  const byChannel = new Map<string, FunnelTotals>();
  const byCommunity = new Map<string, FunnelTotals>();
  const byKind = new Map<string, FunnelTotals>();

  for (const raw of events) {
    const row = raw as EventRow;
    overall = bump(overall, row);

    const channel = channelKeyFor(row);
    byChannel.set(channel, bump(byChannel.get(channel) ?? EMPTY_FUNNEL, row));

    if (row.communityId) {
      byCommunity.set(row.communityId, bump(byCommunity.get(row.communityId) ?? EMPTY_FUNNEL, row));
    }
    if (row.activityId) {
      const kind = activityKind.get(row.activityId);
      if (kind) byKind.set(kind, bump(byKind.get(kind) ?? EMPTY_FUNNEL, row));
    }
  }

  const channels: PerformanceRow[] = [...byChannel.entries()]
    .map(([key, totals]) => ({ key, label: channelLabel(key, input.locale), ...totals }))
    .sort(sortByImpact);

  const communityRows: PerformanceRow[] = [...byCommunity.entries()]
    .map(([key, totals]) => ({
      key,
      label: communityName.get(key) ?? key,
      ...totals,
    }))
    .sort(sortByImpact);

  const content: PerformanceRow[] = [...byKind.entries()]
    .map(([key, totals]) => ({
      key,
      label: isMarketingContentKind(key) ? contentKindLabel(key, input.locale) : key,
      ...totals,
    }))
    .sort(sortByImpact);

  const touched = new Set(byCommunity.keys());
  const untriedCommunityLabels = communities
    .filter((c) => !c.archivedAt && !touched.has(c.id))
    .map((c) => c.name);

  return {
    windowDays,
    overall,
    channels,
    communities: communityRows,
    content,
    untriedCommunityLabels,
    observations: deriveObservations({
      channels,
      communities: communityRows,
      untriedCommunityLabels,
    }),
  };
}

function sortByImpact(a: PerformanceRow, b: PerformanceRow): number {
  if (b.students !== a.students) return b.students - a.students;
  if (b.enquiries !== a.enquiries) return b.enquiries - a.enquiries;
  return b.visits - a.visits;
}

/** Headline numbers for the Get Students landing card. */
export async function acquisitionHeadline(
  teacherId: string,
  windowDays: AcquisitionWindow = 30,
): Promise<FunnelTotals> {
  const since = new Date(Date.now() - windowDays * 86400_000);
  const rows = await prisma.acquisitionEvent.groupBy({
    by: ["kind"],
    where: { teacherId, occurredAt: { gte: since } },
    _count: { _all: true },
    _sum: { amountMinorUnits: true },
  });
  let out = EMPTY_FUNNEL;
  for (const r of rows) {
    if (r.kind === "visit") out = { ...out, visits: r._count._all };
    else if (r.kind === "enquiry") out = { ...out, enquiries: r._count._all };
    else if (r.kind === "booking") out = { ...out, bookings: r._count._all };
    else if (r.kind === "purchase") {
      out = {
        ...out,
        students: r._count._all,
        revenueMinorUnits: r._sum.amountMinorUnits ?? 0,
      };
    }
  }
  return out;
}
