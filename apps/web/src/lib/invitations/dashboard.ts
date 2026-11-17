import type { NotificationStatus, Prisma, PrismaClient, StudentInvitation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { INVITATION_NOTIFICATION_TEMPLATE } from "./constants";
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
  // The address the latest send of this invitation went to, when that send
  // bounced or failed at the provider (issue #85); null otherwise. Set only
  // while the invitation is still pending or expired, so the teacher is asked
  // to check it. It is the invitation's address, which can differ from the
  // roster email shown above it once the teacher corrects that.
  undeliveredTo: string | null;
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

function invitationIdFromMetadata(metadata: Prisma.JsonValue | null): string | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const id = (metadata as Record<string, unknown>).invitationId;
  return typeof id === "string" ? id : null;
}

// Build the whole dashboard in three queries: the active roster, all this
// teacher's invitations (latest-first), and the send records the delivery
// webhook updates (latest-first). Teacher-scoped throughout (tenant isolation).
export async function buildInvitationDashboard(
  teacherId: string,
  db: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<InvitationDashboard> {
  const [links, invitations, sends] = await Promise.all([
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
    db.notification.findMany({
      where: {
        teacherId,
        recipientType: "student",
        templateName: INVITATION_NOTIFICATION_TEMPLATE,
      },
      orderBy: { createdAt: "desc" },
      select: { status: true, metadata: true },
    }),
  ]);

  // Latest invitation per student (list is already newest-first).
  const latestByStudent = new Map<string, StudentInvitation>();
  for (const inv of invitations) {
    if (!latestByStudent.has(inv.studentId)) latestByStudent.set(inv.studentId, inv);
  }

  // Outcome of the latest send per invitation. Each send and resend writes its
  // own row, so a resend that has not bounced clears an earlier bounce.
  const latestSendStatus = new Map<string, NotificationStatus>();
  for (const send of sends) {
    const invitationId = invitationIdFromMetadata(send.metadata);
    if (invitationId && !latestSendStatus.has(invitationId)) {
      latestSendStatus.set(invitationId, send.status);
    }
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
      undeliveredTo:
        latest != null &&
        (state === "pending" || state === "expired") &&
        latestSendStatus.get(latest.id) === "failed"
          ? latest.email
          : null,
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
