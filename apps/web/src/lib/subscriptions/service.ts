import type { Prisma, PrismaClient, TeacherSubscription } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  FOUNDING_MAX_TEACHERS,
  planPriceMinorUnits,
  TRIAL_DAYS,
  foundingCutoffDate,
  type SubscriptionPlan,
} from "./config";
import { entitlementsFor, type Entitlements, type SubscriptionLike } from "./entitlements";

// Server-side subscription data layer. Owns the "ensure a row exists" and
// "load entitlements" reads that the auth boundary, settings UI, and the
// enforcement points share, plus the founding-cohort open/closed check.
//
// All writes that mutate billing lifecycle (activate, past_due, cancel, drop to
// free) live in lifecycle.ts and run from the webhook / Inngest sweeps under the
// service role. This module is read-mostly; the one write here is the
// idempotent trial-row provision for a brand-new teacher.

type Tx = Prisma.TransactionClient | PrismaClient;

// Ensure the teacher has a subscription row. New teachers (and any teacher
// missing a row) start on a 30-day Pro trial — never locked out. Idempotent:
// returns the existing row when present. Called from the auth boundary's
// lazy teacher-create path.
export async function ensureSubscriptionForTeacher(
  teacherId: string,
  now: Date = new Date(),
  tx: Tx = prisma,
): Promise<TeacherSubscription> {
  const existing = await tx.teacherSubscription.findUnique({ where: { teacherId } });
  if (existing) return existing;
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  // upsert guards the race where two requests provision concurrently.
  return tx.teacherSubscription.upsert({
    where: { teacherId },
    create: { teacherId, plan: "free", status: "trialing", trialEndsAt },
    update: {},
  });
}

// Load a teacher's subscription row (or null). Read-only — does NOT provision.
export async function getSubscription(
  teacherId: string,
  tx: Tx = prisma,
): Promise<TeacherSubscription | null> {
  return tx.teacherSubscription.findUnique({ where: { teacherId } });
}

// The entitlements for a teacher. Resilient: a missing row resolves to Free
// (never locks anyone out), but for a known teacher the caller should have
// provisioned a trial via ensureSubscriptionForTeacher at signup.
export async function loadEntitlements(
  teacherId: string,
  now: Date = new Date(),
  tx: Tx = prisma,
): Promise<Entitlements> {
  const sub = await getSubscription(teacherId, tx);
  return entitlementsFor(sub as SubscriptionLike, now);
}

// --- Founding cohort -------------------------------------------------------

export type FoundingCohortState = {
  headcount: number;
  cap: number;
  cutoffAt: Date;
  isOpen: boolean;
};

// Read the founding-cohort source-of-truth row, applying the config defaults
// when ops hasn't overridden the cutoff/cap. The headcount is also derivable
// from teacher_subscriptions, but the row makes the check a single cheap read;
// we reconcile it from the live count to stay correct even if a write was
// missed.
export async function getFoundingCohortState(
  now: Date = new Date(),
  tx: Tx = prisma,
): Promise<FoundingCohortState> {
  const [row, liveCount] = await Promise.all([
    tx.foundingCohort.findUnique({ where: { id: "default" } }),
    tx.teacherSubscription.count({ where: { plan: "founding" } }),
  ]);
  const headcount = Math.max(row?.headcount ?? 0, liveCount);
  const cap = row?.maxTeachers ?? FOUNDING_MAX_TEACHERS;
  const cutoffAt = row?.cutoffAt ?? foundingCutoffDate();
  const isOpen = headcount < cap && now < cutoffAt;
  return { headcount, cap, cutoffAt, isOpen };
}

// The price (minor units) a teacher would be locked to for a given plan, in
// their billing currency (defaults to the canonical GBP currency). For
// `founding` this is the locked price; it never auto-increases.
export function lockedPriceForPlan(plan: SubscriptionPlan, currency: string = "GBP"): number {
  return planPriceMinorUnits(plan, currency);
}
