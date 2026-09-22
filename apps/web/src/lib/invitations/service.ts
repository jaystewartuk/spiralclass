import type { PrismaClient, Teacher } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { flagEnabled } from "@/lib/flags";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import {
  classifyInvitees,
  normalizeEmail,
  parseInviteeList,
  type ClassifiedInvitee,
  type ParsedInvitee,
  type ParseResult,
} from "./bulk";
import { discardUnsentInvitation, markInvitationSent, provisionInvitation } from "./manage";
import { sendInvitationEmail, invitationEmailLocale } from "./send";

// Server-side orchestration for creating + sending invitations, owned here so
// every caller behaves identically.

// Messaging benefit is shown unless an operator hides it — messaging is a
// shipped feature, so "if enabled" defaults to on, flip off via env.
export function messagingBenefitEnabled(): boolean {
  return !flagEnabled("FLAG_INVITE_HIDE_MESSAGING");
}

export type CollectInput = {
  // Free-text pasted list or CSV blob.
  list?: string | null;
  // Already-rostered student ids the teacher multi-selected.
  studentIds?: string[];
};

// Turn the raw invite input into a flat, de-duplicated list of parsed invitees.
// `list` rows are parsed by bulk.ts; `studentIds` are resolved to their roster
// email (skipping any with no email — they can't be emailed an invite).
export async function collectInvitees(
  teacherId: string,
  input: CollectInput,
  db: PrismaClient = prisma,
): Promise<ParseResult> {
  const fromList: ParseResult = input.list
    ? parseInviteeList(input.list)
    : { entries: [], issues: [], truncated: false };

  const entries: ParsedInvitee[] = [...fromList.entries];
  if (input.studentIds && input.studentIds.length > 0) {
    const students = await db.student.findMany({
      where: {
        id: { in: input.studentIds },
        teacherStudents: { some: { teacherId } },
      },
      select: { id: true, name: true, email: true },
    });
    for (const s of students) {
      if (!s.email) continue;
      entries.push({
        name: s.name,
        email: normalizeEmail(s.email),
        rawLine: s.email,
        lineNumber: 0,
      });
    }
  }
  return { entries, issues: fromList.issues, truncated: fromList.truncated };
}

// Classify parsed invitees against this teacher's live state (already-connected
// logins + outstanding pending invitations). The confirmation screen renders
// this before anything is sent.
export async function classifyForTeacher(
  teacherId: string,
  entries: ParsedInvitee[],
  db: PrismaClient = prisma,
) {
  const emails = [...new Set(entries.map((e) => e.email))];
  const [connected, pending] = await Promise.all([
    emails.length
      ? db.student.findMany({
          where: {
            email: { in: emails },
            authUserId: { not: null },
            teacherStudents: { some: { teacherId } },
          },
          select: { email: true },
        })
      : Promise.resolve([]),
    emails.length
      ? db.studentInvitation.findMany({
          where: { teacherId, email: { in: emails }, status: "pending" },
          select: { email: true },
        })
      : Promise.resolve([]),
  ]);
  const connectedEmails = new Set(
    connected
      .map((s) => s.email!)
      .filter(Boolean)
      .map(normalizeEmail),
  );
  const pendingEmails = new Set(pending.map((p) => normalizeEmail(p.email)));
  return classifyInvitees({ entries, connectedEmails, pendingEmails });
}

export type SendSummary = {
  sent: number;
  failed: number;
  skippedConnected: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  sentInvitationIds: string[];
};

type TeacherCtx = Pick<Teacher, "id" | "name" | "photoPath" | "updatedAt" | "locale">;

// Provision + email each SENDABLE invitee. Runs sequentially — an invite email
// send is IO and the bulk cap (200) keeps this bounded; a single failure is
// isolated (that invite is discarded, the rest proceed). Idempotent per email
// via the advisory-locked provision.
export async function sendInvitations(
  teacher: TeacherCtx,
  sendable: ClassifiedInvitee[],
  db: PrismaClient = prisma,
): Promise<{
  summary: SendSummary;
  results: Array<{ email: string; invitationId: string; rawToken: string }>;
}> {
  const avatarUrl = teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime());
  const messagingEnabled = messagingBenefitEnabled();
  const summary: SendSummary = {
    sent: 0,
    failed: 0,
    skippedConnected: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    sentInvitationIds: [],
  };
  const results: Array<{ email: string; invitationId: string; rawToken: string }> = [];

  for (const invitee of sendable) {
    const provisioned = await provisionInvitation(
      { teacherId: teacher.id, email: invitee.email, name: invitee.name },
      db,
    );
    if (provisioned.status !== "created") {
      // A race turned it into connected/pending/teacher-conflict between
      // classify and send — count it as skipped, don't send.
      if (provisioned.status === "already_connected") summary.skippedConnected += 1;
      else summary.skippedDuplicate += 1;
      continue;
    }
    try {
      await sendInvitationEmail({
        to: invitee.email,
        teacherName: teacher.name,
        studentName: invitee.name,
        rawToken: provisioned.rawToken,
        locale: invitationEmailLocale(provisioned.studentLocale, teacher.locale),
        teacherAvatarUrl: avatarUrl,
        messagingEnabled,
      });
      await markInvitationSent(provisioned.invitation.id, { resend: false }, db);
      summary.sent += 1;
      summary.sentInvitationIds.push(provisioned.invitation.id);
      results.push({
        email: invitee.email,
        invitationId: provisioned.invitation.id,
        rawToken: provisioned.rawToken,
      });
    } catch {
      // Delivery failed — roll the never-sent row back so it doesn't show as a
      // ghost "pending" that was never emailed.
      await discardUnsentInvitation(provisioned.invitation.id, db);
      summary.failed += 1;
    }
  }
  return { summary, results };
}
