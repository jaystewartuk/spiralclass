import type { PrismaClient } from "@prisma/client";
import {
  verifyNotificationSettingsToken,
  type NotificationSettingsLinkPayload,
} from "./settings-link-token";

// Pure-handler-takes-deps split for the notification-settings redirect link.
// The route lives in src/app/r/notif-settings/[token]/page.tsx; this is the
// testable inner surface it calls.
//
// Resolves the token to *whichever Supabase auth user id* (if any) the
// recipient is currently linked to, so callers can compare it against the
// device's locally signed-in accounts without another round trip:
//   - teacher recipients: Teacher.id === auth.users.id directly.
//   - student recipients: Student.id is a roster row id, distinct from the
//     auth user id — the link only exists once the student has signed in at
//     least once (Student.authUserId). A student who never signed in has no
//     account to match against, so `accountId` comes back null and callers
//     fall through to the "not signed in on this device" path.

export type ResolvedNotificationSettingsTarget = {
  accountId: string | null;
  role: "teacher" | "student";
  email: string;
  name: string;
};

export type ResolveNotificationSettingsLinkResult =
  | { ok: true; target: ResolvedNotificationSettingsTarget }
  | { ok: false; reason: "invalid-token" | "not-found" };

export type NotificationSettingsLinkDeps = {
  prisma: Pick<PrismaClient, "teacher" | "student">;
  secret: string;
  now?: () => Date;
};

export async function resolveNotificationSettingsLink(
  deps: NotificationSettingsLinkDeps,
  token: string,
): Promise<ResolveNotificationSettingsLinkResult> {
  const now = (deps.now ?? (() => new Date()))();
  const verified = verifyNotificationSettingsToken(token, deps.secret, now);
  if (!verified.ok) {
    return { ok: false, reason: "invalid-token" };
  }
  return resolveVerifiedPayload(deps, verified.payload);
}

async function resolveVerifiedPayload(
  deps: NotificationSettingsLinkDeps,
  payload: NotificationSettingsLinkPayload,
): Promise<ResolveNotificationSettingsLinkResult> {
  if (payload.recipientType === "teacher") {
    if (payload.recipientId !== payload.teacherId) {
      // A teacher recipient's id must be the owning teacher's id — a token
      // claiming otherwise doesn't match how these are minted and is refused.
      return { ok: false, reason: "invalid-token" };
    }
    const teacher = await deps.prisma.teacher.findUnique({
      where: { id: payload.recipientId },
      select: { id: true, email: true, name: true },
    });
    if (!teacher) return { ok: false, reason: "not-found" };
    return {
      ok: true,
      target: { accountId: teacher.id, role: "teacher", email: teacher.email, name: teacher.name },
    };
  }

  const student = await deps.prisma.student.findFirst({
    where: {
      id: payload.recipientId,
      teacherStudents: { some: { teacherId: payload.teacherId } },
    },
    select: { authUserId: true, email: true, name: true },
  });
  if (!student?.email) return { ok: false, reason: "not-found" };
  return {
    ok: true,
    target: {
      accountId: student.authUserId,
      role: "student",
      email: student.email,
      name: student.name,
    },
  };
}
