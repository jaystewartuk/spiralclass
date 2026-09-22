import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { createT } from "@spiralclass/shared";
import type { AppLocale } from "@/lib/i18n";
import { FREE_MAX_ACTIVE_STUDENTS, FREE_MAX_PACKAGE_TEMPLATES } from "./config";
import { loadEntitlements } from "./service";

// Entitlement enforcement at the exact mutation points (NOT scattered checks).
// Each gate loads the central resolver once, counts the live usage, and — when
// the teacher would exceed a Free cap or touch a Pro-only feature — returns a
// blocked result and emits the `plan_limit_hit` funnel event. Callers turn the
// reason into a localized upgrade nudge via upgradeNudge().
//
// Hard rules honored here:
//   * Never delete data on downgrade — these gates only block ADDING beyond the
//     cap; existing over-cap rows keep working (read-only).
//   * Never paywall getting paid — the public booking/checkout flow does NOT
//     call gateAddStudent; only teacher-initiated adds + roster import do.

type Tx = Prisma.TransactionClient | PrismaClient;

export type PlanLimit =
  | "students"
  | "templates"
  | "materials"
  | "class_content"
  | "custom_price"
  | "lesson_notes"
  | "homework_review";

export type GateResult = { ok: true } | { ok: false; limit: PlanLimit; cap?: number };

// The two capped resources, as `where` clauses rather than inline counts.
//
// Extracted so the billing page's "2 of 3 students" panel (subscriptions/
// usage.ts) counts the SAME rows this gate counts. A displayed number that
// disagreed with the gate is the worst bug available on that surface: the
// teacher is told she has room, refused when she uses it, and has no way to
// know which of the two numbers is wrong. Exported rather than duplicated so
// there is one definition of "active" per resource.
export const ACTIVE_STUDENTS_WHERE = (teacherId: string) => ({ teacherId, archivedAt: null });
export const ACTIVE_TEMPLATES_WHERE = (teacherId: string) => ({ teacherId, archived: false });

// Block adding an ACTIVE student past the Free cap. "Active" = a non-archived
// (teacher, student) link. Pro is unlimited.
export async function gateAddStudent(teacherId: string, tx: Tx = prisma): Promise<GateResult> {
  const ent = await loadEntitlements(teacherId, new Date(), tx);
  if (ent.studentLimit === Number.POSITIVE_INFINITY) return { ok: true };
  const activeCount = await tx.teacherStudent.count({
    where: ACTIVE_STUDENTS_WHERE(teacherId),
  });
  if (activeCount >= ent.studentLimit) {
    emitLimitHit(teacherId, "students");
    return { ok: false, limit: "students", cap: ent.studentLimit };
  }
  return { ok: true };
}

// Block creating a package template past the Free cap. Pro is unlimited.
export async function gateAddTemplate(teacherId: string, tx: Tx = prisma): Promise<GateResult> {
  const ent = await loadEntitlements(teacherId, new Date(), tx);
  if (ent.templateLimit === Number.POSITIVE_INFINITY) return { ok: true };
  const count = await tx.packageTemplate.count({
    where: ACTIVE_TEMPLATES_WHERE(teacherId),
  });
  if (count >= ent.templateLimit) {
    emitLimitHit(teacherId, "templates");
    return { ok: false, limit: "templates", cap: ent.templateLimit };
  }
  return { ok: true };
}

// Replace-set variant for the template wizard (web onboarding),
// which submits the whole desired set at once. Allows the resulting active
// count up to the cap, and grandfathers an already-over-cap teacher (they can
// keep/edit what they have, just not INCREASE past the cap). Pro is unlimited.
export async function gateTemplateSet(
  teacherId: string,
  resultingActiveCount: number,
  existingActiveCount: number,
  tx: Tx = prisma,
): Promise<GateResult> {
  const ent = await loadEntitlements(teacherId, new Date(), tx);
  if (ent.templateLimit === Number.POSITIVE_INFINITY) return { ok: true };
  if (resultingActiveCount <= ent.templateLimit) return { ok: true };
  // Grandfather: not increasing beyond what they already had.
  if (resultingActiveCount <= existingActiveCount) return { ok: true };
  emitLimitHit(teacherId, "templates");
  return { ok: false, limit: "templates", cap: ent.templateLimit };
}

// Pro-only feature gate (class-materials scheduling, class-content authoring +
// AI compose, per-student custom price, live-notes present mode + realtime
// student panel — D-15/D-17). class_content rides the same Pro entitlement as
// materials — both are content-authoring tools, free to view and Pro to author.
export async function gateProFeature(
  teacherId: string,
  feature: "materials" | "class_content" | "custom_price" | "lesson_notes" | "homework_review",
  tx: Tx = prisma,
): Promise<GateResult> {
  const ent = await loadEntitlements(teacherId, new Date(), tx);
  const allowed =
    feature === "materials" || feature === "class_content"
      ? ent.canScheduleMaterials
      : feature === "custom_price"
        ? ent.canCustomPrice
        : feature === "homework_review"
          ? ent.canUseHomeworkAiReview
          : ent.canUseLiveNotes;
  if (allowed) return { ok: true };
  emitLimitHit(teacherId, feature);
  return { ok: false, limit: feature };
}

function emitLimitHit(teacherId: string, limit: PlanLimit): void {
  trackServerEvent({
    name: "plan_limit_hit",
    distinctId: teacherId,
    properties: { teacherId, limit },
  });
}

// Localized upgrade nudge for a blocked gate, so every caller returns a
// consistent "upgrade to Pro" message.
export function upgradeNudge(limit: PlanLimit, locale: AppLocale): string {
  const t = createT(locale);
  switch (limit) {
    // The caps are INTERPOLATED, not written into the prose: they live in
    // subscriptions-config, so raising one would otherwise leave this message
    // quoting the old number at the exact moment a teacher is deciding whether
    // to pay us. `count` also selects the CLDR plural, retiring the
    // "1 plantilla(s)" shape the hand-written strings had.
    case "students":
      return t("billing.limit.students", { count: FREE_MAX_ACTIVE_STUDENTS });
    case "templates":
      return t("billing.limit.templates", { count: FREE_MAX_PACKAGE_TEMPLATES });
    case "materials":
      return t("billing.limit.materials");
    case "class_content":
      return t("billing.limit.classContent");
    case "custom_price":
      return t("billing.limit.customPrice");
    case "lesson_notes":
      return t("billing.limit.lessonNotes");
    case "homework_review":
      return t("billing.limit.homeworkReview");
  }
}
