// Acquisition analytics: funnel maths and the observation engine.
//
// Two rules shape this module, and both are about not lying to a teacher who is
// making real decisions about where to spend her limited hours:
//
//   1. NOTHING here is generated. Every number is a count from the acquisition
//      ledger and every observation is derived arithmetically from those counts.
//      A language model never gets to conclude "Facebook is working for you".
//   2. Confidence is explicit and it gates. An observation is `observed` (a raw
//      fact), `pattern` (a comparison that clears a sample-size and effect-size
//      floor), or `suggestion` (an action implied by the first two). Below the
//      floor we say "not enough data yet" instead of ranking noise.

import type { AppLocale } from "../i18n/locales";
import { createT } from "../i18n/translate";
import type { StringKey } from "../i18n/catalog";

export type FunnelTotals = {
  visits: number;
  enquiries: number;
  bookings: number;
  students: number;
  revenueMinorUnits: number;
};

export const EMPTY_FUNNEL: FunnelTotals = {
  visits: 0,
  enquiries: 0,
  bookings: 0,
  students: 0,
  revenueMinorUnits: 0,
};

/** One row of a breakdown — a channel, a community, or a content kind. */
export type PerformanceRow = FunnelTotals & {
  key: string;
  label: string;
};

export function addTotals(a: FunnelTotals, b: Partial<FunnelTotals>): FunnelTotals {
  return {
    visits: a.visits + (b.visits ?? 0),
    enquiries: a.enquiries + (b.enquiries ?? 0),
    bookings: a.bookings + (b.bookings ?? 0),
    students: a.students + (b.students ?? 0),
    revenueMinorUnits: a.revenueMinorUnits + (b.revenueMinorUnits ?? 0),
  };
}

/** Visit to enquiry, as a 0..1 fraction. Null when there are no visits. */
export function enquiryRate(t: FunnelTotals): number | null {
  return t.visits > 0 ? t.enquiries / t.visits : null;
}

/** Visit to paying student. Null when there are no visits. */
export function conversionRate(t: FunnelTotals): number | null {
  return t.visits > 0 ? t.students / t.visits : null;
}

// ── The funnel proper ──────────────────────────────────────────────────────

export type FunnelStepKey = "visits" | "bookings" | "students";

export type FunnelStep = {
  key: FunnelStepKey;
  count: number;
  /** Share of the FIRST step, 0..1. Null when there were no visits. */
  shareOfTop: number | null;
  /** Share of the step above, 0..1. Null for the top step, or an empty one. */
  shareOfPrevious: number | null;
  /** How many were lost between the step above and this one; never negative. */
  lostFromPrevious: number;
};

/**
 * The funnel a teacher can act on: visit, then checkout started, then paid.
 *
 * ENQUIRIES ARE DELIBERATELY NOT A STEP, and this is the whole reason the
 * function exists rather than the page mapping over `FunnelTotals`. An enquiry
 * is the contact form; a booking is checkout. Neither requires the other, and
 * most buyers never fill the form — so seating enquiry between visit and
 * checkout produces a step the NEXT one legitimately exceeds, which renders as
 * a conversion above 100% and reads as a bug in the product rather than a fact
 * about the funnel. Enquiry is a parallel outcome (the visitor who is
 * interested but not buying today) and belongs beside the funnel, not inside
 * it. The operator's own PostHog dashboard splits them the same way.
 *
 * `lostFromPrevious` clamps at zero because the steps are not strictly nested
 * in time either: a visit older than the window whose checkout lands inside it
 * counts a booking with no visit above it. Rare, but it renders as a negative
 * loss and a >100% step the first time it happens, so it is handled here once
 * rather than in each caller.
 */
export function funnelSteps(t: FunnelTotals): FunnelStep[] {
  const order: readonly FunnelStepKey[] = ["visits", "bookings", "students"];
  const top = t.visits;
  return order.map((key, i) => {
    const count = t[key];
    const previous = i === 0 ? null : t[order[i - 1]];
    return {
      key,
      count,
      shareOfTop: top > 0 ? count / top : null,
      shareOfPrevious: previous !== null && previous > 0 ? count / previous : null,
      lostFromPrevious: previous === null ? 0 : Math.max(0, previous - count),
    };
  });
}

// ── Confidence floors ──────────────────────────────────────────────────────
//
// Chosen for the reality of one independent teacher, not a growth team: a
// teacher who posts five times a week reaches these inside a month. Set them
// higher and the product never says anything; lower and it says wrong things.

/** Minimum visits on BOTH sides before two channels may be compared. */
export const MIN_VISITS_FOR_COMPARISON = 20;
/** Minimum students before "this channel gets you students" is claimable. */
export const MIN_STUDENTS_FOR_CLAIM = 2;
/** How much better one side must be before the difference is called real. */
export const MIN_EFFECT_RATIO = 1.5;

export type ObservationConfidence = "observed" | "pattern" | "suggestion";

export type Observation =
  | { code: "no_data"; confidence: "observed" }
  | { code: "top_channel"; confidence: "pattern"; label: string; students: number }
  | {
      code: "channel_outperforms";
      confidence: "pattern";
      winner: string;
      loser: string;
      ratio: number;
    }
  | { code: "traffic_no_enquiries"; confidence: "pattern"; label: string; visits: number }
  | { code: "referrals_convert_best"; confidence: "pattern"; ratio: number }
  | { code: "needs_more_data"; confidence: "observed"; visits: number }
  | { code: "try_untried_community"; confidence: "suggestion"; label: string }
  | { code: "repeat_what_works"; confidence: "suggestion"; label: string };

export type InsightsInput = {
  /** Totals per acquisition channel (facebook, reddit, referral, direct, ...). */
  channels: readonly PerformanceRow[];
  /** Totals per saved community. */
  communities: readonly PerformanceRow[];
  /** Communities the teacher saved but has never posted to. */
  untriedCommunityLabels: readonly string[];
};

function totalOf(rows: readonly PerformanceRow[]): FunnelTotals {
  return rows.reduce<FunnelTotals>((acc, r) => addTotals(acc, r), EMPTY_FUNNEL);
}

/**
 * Derive what can honestly be said about a teacher's acquisition, ordered
 * most-useful first. Returns at most a handful — this feeds a card, not a
 * report, and an unranked wall of statements is the failure mode.
 */
export function deriveObservations(input: InsightsInput): Observation[] {
  const out: Observation[] = [];
  const overall = totalOf(input.channels);

  if (overall.visits === 0) {
    out.push({ code: "no_data", confidence: "observed" });
    return out;
  }

  const ranked = input.channels.slice().sort((a, b) => b.students - a.students);
  const top = ranked[0];

  if (top && top.students >= MIN_STUDENTS_FOR_CLAIM) {
    out.push({
      code: "top_channel",
      confidence: "pattern",
      label: top.label,
      students: top.students,
    });
  }

  // A head-to-head is only stated when both sides have enough traffic AND the
  // gap clears the effect floor. Without both, two channels differing by one
  // student is noise dressed as a finding.
  const comparable = input.channels.filter((c) => c.visits >= MIN_VISITS_FOR_COMPARISON);
  if (comparable.length >= 2) {
    const byRate = comparable
      .map((c) => ({ row: c, rate: conversionRate(c) ?? 0 }))
      .sort((a, b) => b.rate - a.rate);
    const best = byRate[0];
    const worst = byRate[byRate.length - 1];
    if (best.rate > 0 && worst.rate > 0 && best.rate / worst.rate >= MIN_EFFECT_RATIO) {
      out.push({
        code: "channel_outperforms",
        confidence: "pattern",
        winner: best.row.label,
        loser: worst.row.label,
        ratio: Math.round((best.rate / worst.rate) * 10) / 10,
      });
    }
  }

  // Traffic that never enquires is the single most actionable negative finding:
  // it means the channel works and the page (or the audience) does not.
  for (const c of input.channels) {
    if (c.visits >= MIN_VISITS_FOR_COMPARISON && c.enquiries === 0 && c.students === 0) {
      out.push({
        code: "traffic_no_enquiries",
        confidence: "pattern",
        label: c.label,
        visits: c.visits,
      });
      break;
    }
  }

  const referral = input.channels.find((c) => c.key === "referral");
  const nonReferral = input.channels.filter((c) => c.key !== "referral");
  if (referral && referral.visits >= MIN_VISITS_FOR_COMPARISON) {
    const others = totalOf(nonReferral);
    const rRate = conversionRate(referral);
    const oRate = conversionRate(others);
    if (
      rRate &&
      oRate &&
      others.visits >= MIN_VISITS_FOR_COMPARISON &&
      rRate / oRate >= MIN_EFFECT_RATIO
    ) {
      out.push({
        code: "referrals_convert_best",
        confidence: "pattern",
        ratio: Math.round((rRate / oRate) * 10) / 10,
      });
    }
  }

  if (out.length === 0) {
    out.push({ code: "needs_more_data", confidence: "observed", visits: overall.visits });
  }

  // Suggestions come last and only ever restate an action implied above.
  const bestCommunity = input.communities.slice().sort((a, b) => b.students - a.students)[0];
  if (bestCommunity && bestCommunity.students >= MIN_STUDENTS_FOR_CLAIM) {
    out.push({ code: "repeat_what_works", confidence: "suggestion", label: bestCommunity.label });
  }
  if (input.untriedCommunityLabels.length > 0) {
    out.push({
      code: "try_untried_community",
      confidence: "suggestion",
      label: input.untriedCommunityLabels[0],
    });
  }

  return out;
}

const CONFIDENCE_LABELS: Record<ObservationConfidence, StringKey> = {
  observed: "marketing.insight.confidence.observed",
  pattern: "marketing.insight.confidence.pattern",
  suggestion: "marketing.insight.confidence.suggestion",
};

export function confidenceLabel(c: ObservationConfidence, locale: AppLocale): string {
  return createT(locale)(CONFIDENCE_LABELS[c]);
}

/**
 * The sentence for an observation, in the reader's language.
 *
 * Whole sentences from the catalog, plurals chosen by the catalog. They were
 * three-way ternaries with endings pasted on ("alumno" + "s"), so a fourth
 * language would have meant a fourth arm in every case, and nothing would have
 * said so.
 */
export function observationText(o: Observation, locale: AppLocale): string {
  const t = createT(locale);
  switch (o.code) {
    case "no_data":
      return t("marketing.insight.noData");
    case "top_channel":
      return t("marketing.insight.topChannel", { label: o.label, count: o.students });
    case "channel_outperforms":
      return t("marketing.insight.channelOutperforms", {
        winner: o.winner,
        loser: o.loser,
        ratio: o.ratio,
      });
    case "traffic_no_enquiries":
      return t("marketing.insight.trafficNoEnquiries", { label: o.label, count: o.visits });
    case "referrals_convert_best":
      return t("marketing.insight.referralsConvertBest", { ratio: o.ratio });
    case "needs_more_data":
      return t("marketing.insight.needsMoreData", { count: o.visits });
    case "repeat_what_works":
      return t("marketing.insight.repeatWhatWorks", { label: o.label });
    case "try_untried_community":
      return t("marketing.insight.tryUntriedCommunity", { label: o.label });
  }
}
