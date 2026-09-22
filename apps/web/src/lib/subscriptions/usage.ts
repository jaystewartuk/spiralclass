import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Entitlements } from "./entitlements";
import { ACTIVE_STUDENTS_WHERE, ACTIVE_TEMPLATES_WHERE } from "./enforce";

// What a teacher has USED of the two capped resources, for the "what your plan
// covers" panel on the billing page.
//
// The counts come from the same `where` clauses the gates in enforce.ts count
// with — imported, not re-typed. That is the whole point of this module
// existing rather than the page counting for itself: a displayed "2 of 3" that
// disagreed with the gate would be the worst possible bug on this surface,
// because the teacher would be told she has room and then refused, with no way
// to tell which number was lying. There is exactly one query per resource and
// both callers use it.
//
// Over-cap is normal and must not be treated as an error: a teacher who
// downgrades keeps everything she had (data is never deleted on downgrade), so
// `used` legitimately exceeds `limit` and the UI has to say so plainly rather
// than clamp it out of sight.

type Tx = Prisma.TransactionClient | PrismaClient;

export type ResourceUsage = {
  used: number;
  // The cap from the entitlements resolver, or null for an unlimited (Pro)
  // grant. Null rather than Infinity so this survives serialization and so a
  // caller must handle "unlimited" explicitly instead of rendering "of ∞".
  limit: number | null;
  // Grandfathered over the cap after a downgrade. Always false when unlimited.
  overLimit: boolean;
};

export type PlanUsage = {
  students: ResourceUsage;
  templates: ResourceUsage;
};

function usage(used: number, limit: number): ResourceUsage {
  if (!Number.isFinite(limit)) return { used, limit: null, overLimit: false };
  return { used, limit, overLimit: used > limit };
}

// Count the teacher's live usage of the capped resources. Takes the already
// resolved entitlements rather than loading them again — the caller has them,
// and re-loading risks reading a different plan than the one being rendered
// alongside these numbers.
export async function loadPlanUsage(
  teacherId: string,
  entitlements: Entitlements,
  tx: Tx = prisma,
): Promise<PlanUsage> {
  const [students, templates] = await Promise.all([
    tx.teacherStudent.count({ where: ACTIVE_STUDENTS_WHERE(teacherId) }),
    tx.packageTemplate.count({ where: ACTIVE_TEMPLATES_WHERE(teacherId) }),
  ]);
  return {
    students: usage(students, entitlements.studentLimit),
    templates: usage(templates, entitlements.templateLimit),
  };
}
