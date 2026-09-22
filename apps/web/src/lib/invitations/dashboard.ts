import type { PrismaClient, StudentInvitation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { effectiveInvitationStatus } from "./status";

// The per-student status the invitation dashboard renders and filters by. A
// superset of the invitation states, adding the roster-level `not_invited` and
// treating a student who already has a login as `accepted` even if they were
// never formally invited (they self-served) so the funnel numbers are honest.
export type StudentInvitationState =
  "accepted" | "pending" | "expired" | "cancelled" | "not_invited";

export type InvitationDashboardRow = {
  studentId: string;
  studentName: string;
  email: string | null;
  state: StudentInvitationState;
  // The latest invitation for this student, when one exists — carries the id
  // the resend/cancel/copy actions operate on.
  invitationId: string | null;
  invitedAt: Date | null;
  acceptedAt: Date | null;
  lastSentAt: Date | null;
};

export type InvitationStats = {
  totalStudents: number;
  invited: number; // students with at least one (non-cancelled) invitation ever
  accepted: number;
  pending: number;
  expired: number;
  cancelled: number;
  notInvited: number;
};

export type InvitationDashboard = {
  stats: InvitationStats;
  rows: InvitationDashboardRow[];
};

function stateForStudent(
  hasLogin: boolean,
  latest: StudentInvitation | undefined,
  now: Date,
): StudentInvitationState {
  if (hasLogin || latest?.status === "accepted") return "accepted";
  if (!latest) return "not_invited";
  const eff = effectiveInvitationStatus(latest, now);
  // eff is one of pending | accepted | expired | cancelled; accepted handled above.
  return eff;
}

// Build the whole dashboard in two queries: the active roster + all this
// teacher's invitations (latest-first). Teacher-scoped throughout (tenant isolation).
export async function buildInvitationDashboard(
  teacherId: string,
  db: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<InvitationDashboard> {
  const [links, invitations] = await Promise.all([
    db.teacherStudent.findMany({
      where: { teacherId, archivedAt: null },
      select: {
        createdAt: true,
        student: { select: { id: true, name: true, email: true, authUserId: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.studentInvitation.findMany({
      where: { teacherId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Latest invitation per student (list is already newest-first).
  const latestByStudent = new Map<string, StudentInvitation>();
  for (const inv of invitations) {
    if (!latestByStudent.has(inv.studentId)) latestByStudent.set(inv.studentId, inv);
  }

  const rows: InvitationDashboardRow[] = links.map((l) => {
    const latest = latestByStudent.get(l.student.id);
    const state = stateForStudent(l.student.authUserId != null, latest, now);
    return {
      studentId: l.student.id,
      studentName: l.student.name,
      email: l.student.email,
      state,
      invitationId: latest?.id ?? null,
      invitedAt: latest?.createdAt ?? null,
      acceptedAt: latest?.acceptedAt ?? null,
      lastSentAt: latest?.lastSentAt ?? null,
    };
  });

  const stats: InvitationStats = {
    totalStudents: rows.length,
    invited: rows.filter((r) => r.invitationId != null && r.state !== "not_invited").length,
    accepted: rows.filter((r) => r.state === "accepted").length,
    pending: rows.filter((r) => r.state === "pending").length,
    expired: rows.filter((r) => r.state === "expired").length,
    cancelled: rows.filter((r) => r.state === "cancelled").length,
    notInvited: rows.filter((r) => r.state === "not_invited").length,
  };

  return { stats, rows };
}
