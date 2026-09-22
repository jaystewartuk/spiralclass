// Is the booking page itself the thing losing the students?
//
// The acquisition feature could only ever answer "where should I post?". Every
// observation in ./insights.ts names a CHANNEL — top_channel,
// channel_outperforms, traffic_no_enquiries, try_untried_community. That is
// the right question only while the page converts. When it does not, the same
// advice actively misleads: told "Facebook sends visits but no enquiries, try
// another community", a teacher spends her week finding new groups to send
// people to a page that converts nobody. The channel is not the variable when
// every channel reads zero — the page is, and nothing in the product looked at
// it.
//
// WHY THIS IS NOT PART OF THE PLANNER, since that is the obvious place to put
// it and would be a mistake. `PlannedAction` is
// { kind: MarketingContentKind, platform, communityId, studentId, reason },
// and every one of those fields assumes "a piece of content, posted
// somewhere". A page fix has no content kind, no platform and no community, so
// fitting it in means making three fields nullable — and `promoPolicy` gating,
// the community cooldown, the kind-repeat window and `eligibleContentKinds`
// all read exactly those fields. Weakening them to carry a different kind of
// work would put the D-125 platform-safety guard on a type that no longer
// means what it says.
//
// So the two are modelled as peers: DISTRIBUTION (get people to the page) is
// the planner's, CONVERSION (make the page worth arriving at) is this
// module's, and `pageReadiness` is the small arbiter that says which one has
// earned this week's attention. Either half can grow without deforming the
// other.
//
// Like the planner and the observation engine, nothing here is generated. Each
// gap is a fact about a column, and the verdict is arithmetic over the ledger.

import type { FunnelTotals } from "./insights";

/** What is missing from the public page. */
export type PageGapCode =
  | "no_packages"
  | "no_photo"
  | "no_headline"
  | "no_bio"
  | "thin_bio"
  | "no_testimonials"
  | "no_intro_video";

/**
 * How much a gap costs.
 *
 * `blocking` is reserved for the one gap that makes buying literally
 * impossible; it is not a strong word for "important". The split exists so the
 * UI can lead with a page nobody CAN buy from before a page nobody WANTS to.
 */
export type PageGapSeverity = "blocking" | "important" | "polish";

export type PageGap = {
  code: PageGapCode;
  severity: PageGapSeverity;
  /** Where she fixes it — an in-app path, never an external link. */
  href: string;
};

export type PageSignals = {
  hasPhoto: boolean;
  headline: string | null;
  bio: string | null;
  packageCount: number;
  testimonialCount: number;
  hasIntroVideo: boolean;
  /** False when the deploy has no video storage, so it cannot be asked for. */
  introVideoOfferable: boolean;
};

/**
 * A bio shorter than this is present but not doing the job — one line saying
 * "Spanish teacher" tells a visitor nothing she could not read from the
 * headline. Two sentences is the floor for "who you are and who you teach".
 */
export const MIN_USEFUL_BIO_CHARS = 120;

/**
 * Visits needed before the funnel may be used to judge the page at all.
 *
 * Below this, zero checkouts is the expected outcome of a small sample, not
 * evidence of anything — and saying otherwise would be the exact
 * ranking-of-noise that ./insights.ts sets its floors to avoid.
 */
export const MIN_VISITS_TO_JUDGE_PAGE = 15;

const SEVERITY_ORDER: Record<PageGapSeverity, number> = {
  blocking: 0,
  important: 1,
  polish: 2,
};

/**
 * What the page is missing, most costly first.
 *
 * Order within a severity is the order below, which is deliberate: a face and
 * a sentence about who she is do more for a stranger deciding whether to book
 * a teacher than a video she has to be talked into recording.
 */
export function pageGaps(s: PageSignals): PageGap[] {
  const gaps: PageGap[] = [];
  // Nothing to buy — the checkout step cannot be reached at all.
  if (s.packageCount === 0) {
    gaps.push({ code: "no_packages", severity: "blocking", href: "/settings/templates" });
  }
  if (!s.hasPhoto) {
    gaps.push({ code: "no_photo", severity: "important", href: "/settings/booking-page" });
  }
  if (!s.headline?.trim()) {
    gaps.push({ code: "no_headline", severity: "important", href: "/settings/booking-page" });
  }
  const bio = s.bio?.trim() ?? "";
  if (!bio) {
    gaps.push({ code: "no_bio", severity: "important", href: "/settings/booking-page" });
  } else if (bio.length < MIN_USEFUL_BIO_CHARS) {
    gaps.push({ code: "thin_bio", severity: "polish", href: "/settings/booking-page" });
  }
  if (s.testimonialCount === 0) {
    gaps.push({ code: "no_testimonials", severity: "polish", href: "/dashboard/testimonials" });
  }
  // Only when the deploy can actually store one — otherwise this is a chore
  // she cannot complete.
  if (s.introVideoOfferable && !s.hasIntroVideo) {
    gaps.push({ code: "no_intro_video", severity: "polish", href: "/settings/booking-page" });
  }
  return gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Why the page is or is not this week's work.
 *
 * `traffic_not_converting` is the only code that leans on the funnel, and it
 * deliberately stops at "these are missing, and nobody is buying". It never
 * says the gaps CAUSED the zero — one teacher's month of visits cannot support
 * that, and a product that claims it teaches her to trust a number that has
 * not earned it.
 */
export type PageVerdictCode =
  "cannot_buy" | "traffic_not_converting" | "not_enough_traffic" | "ready";

export type PageReadiness = {
  gaps: PageGap[];
  verdict: PageVerdictCode;
  /** Visits the verdict was formed on, so the UI can show its own evidence. */
  visits: number;
  /** True when the page should outrank this week's posting actions. */
  isBottleneck: boolean;
};

export function pageReadiness(signals: PageSignals, funnel: FunnelTotals): PageReadiness {
  const gaps = pageGaps(signals);
  const visits = funnel.visits;
  const verdict: PageVerdictCode = gaps.some((g) => g.severity === "blocking")
    ? "cannot_buy"
    : gaps.length === 0
      ? "ready"
      : visits >= MIN_VISITS_TO_JUDGE_PAGE && funnel.bookings === 0
        ? "traffic_not_converting"
        : "not_enough_traffic";
  return {
    gaps,
    verdict,
    visits,
    isBottleneck: verdict === "cannot_buy" || verdict === "traffic_not_converting",
  };
}
