// Central entitlements resolver. THE one place that decides what a teacher's
// current plan unlocks. Enforce it at the exact mutation points (add-student,
// create-template, materials scheduling, custom pricing) —
// never scatter ad-hoc plan checks. Also drives the billing/settings UI and the
// pricing page's "what you get by upgrading" list.
//
// Pure + clock-aware: given a subscription row (or null) and `now`, it returns
// the effective entitlements. It defends against a lagging cron by computing an
// *effective* status — a trial whose end has passed, or a past_due grace that
// has elapsed, resolves to Free even before the sweep flips the DB row. It
// never locks a teacher out: a missing/unknown subscription resolves to Free,
// and Free is a genuinely usable tier.

import {
  FREE_MAX_ACTIVE_STUDENTS,
  FREE_MAX_PACKAGE_TEMPLATES,
  PAST_DUE_GRACE_DAYS,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from "./subscriptions-config";

// The subset of teacher_subscriptions the resolver reads. Accepts the Prisma
// row directly or a plain test object.
export type SubscriptionLike = {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  comped: boolean;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
} | null;

export type Entitlements = {
  // The plan to surface in the UI ("free" while trialing-without-a-paid-plan).
  plan: SubscriptionPlan;
  // The effective billing status after the clock is applied.
  status: SubscriptionStatus;
  // True when the teacher currently has the full Pro feature set.
  isPro: boolean;
  // True while a Pro trial is running (drives the "X days left" banner).
  isTrialing: boolean;
  // True while in the past_due grace window (drives the "update payment" banner).
  isPastDue: boolean;
  // Internal comp (full Pro, never billed).
  comped: boolean;
  // Pro entitlements (the resolver is the single gate for all of them).
  canScheduleMaterials: boolean;
  canCustomPrice: boolean;
  // Live notes (D-15): authoring is free, but the live surfaces — present mode
  // and the realtime student panel — are Pro.
  canUseLiveNotes: boolean;
  // Intro-video AI coach (D-73, Layer 2/3): transcribe the teacher's public
  // intro video and coach them on it (+ captions, draft bio). A Pro growth tool
  // — recording/showing the video is always free; only the AI analysis is gated.
  canUseIntroVideoCoach: boolean;
  // Homework AI review (homework workflow slice 5): teacher-triggered Claude
  // review of a student's submission attempt. Reviewing/grading by hand is
  // always free; only the AI-assist draft is gated, same "AI analysis is Pro"
  // pattern as canUseIntroVideoCoach.
  canUseHomeworkAiReview: boolean;
  // Caps — Infinity for Pro, the Free constants otherwise.
  studentLimit: number;
  templateLimit: number;
};

// Compute the effective status given the clock. The DB status is authoritative
// for everything the webhook/cron maintains; this only *downgrades* a stale
// trialing/past_due whose window has elapsed, so we never grant Pro past its
// expiry even if the sweep hasn't run yet. Never upgrades.
export function effectiveStatus(sub: SubscriptionLike, now: Date): SubscriptionStatus {
  if (!sub) return "free";
  if (sub.comped) return "active";
  if (sub.status === "trialing") {
    if (sub.trialEndsAt && sub.trialEndsAt.getTime() <= now.getTime()) return "free";
    return "trialing";
  }
  if (sub.status === "past_due") {
    // Grace runs from the period end (or, defensively, from now if absent).
    const graceEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000)
      : null;
    if (graceEnd && graceEnd.getTime() <= now.getTime()) return "free";
    return "past_due";
  }
  return sub.status;
}

// Whether an effective status grants the Pro feature set. trialing + past_due
// keep full Pro (the whole point of the trial and the grace window). `active`
// is Pro. `free`/`canceled` are not.
function statusGrantsPro(status: SubscriptionStatus): boolean {
  return status === "trialing" || status === "active" || status === "past_due";
}

const PRO_ENTITLEMENTS = {
  canScheduleMaterials: true,
  canCustomPrice: true,
  canUseLiveNotes: true,
  canUseIntroVideoCoach: true,
  canUseHomeworkAiReview: true,
  studentLimit: Number.POSITIVE_INFINITY,
  templateLimit: Number.POSITIVE_INFINITY,
} as const;

const FREE_ENTITLEMENTS = {
  canScheduleMaterials: false,
  canCustomPrice: false,
  canUseLiveNotes: false,
  canUseIntroVideoCoach: false,
  canUseHomeworkAiReview: false,
  studentLimit: FREE_MAX_ACTIVE_STUDENTS,
  templateLimit: FREE_MAX_PACKAGE_TEMPLATES,
} as const;

export function entitlementsFor(sub: SubscriptionLike, now: Date = new Date()): Entitlements {
  const status = effectiveStatus(sub, now);
  const comped = Boolean(sub?.comped);
  const isPro = comped || statusGrantsPro(status);
  const base = isPro ? PRO_ENTITLEMENTS : FREE_ENTITLEMENTS;
  const plan = sub?.plan ?? "free";
  return {
    plan,
    status,
    isPro,
    isTrialing: status === "trialing",
    isPastDue: status === "past_due",
    comped,
    ...base,
  };
}

// The Free entitlements, for the pricing page's "what you get by upgrading"
// comparison and tests. Kept here so the UI never re-derives the caps.
export function freeEntitlements(): Entitlements {
  return entitlementsFor({
    plan: "free",
    status: "free",
    comped: false,
    trialEndsAt: null,
    currentPeriodEnd: null,
  });
}
