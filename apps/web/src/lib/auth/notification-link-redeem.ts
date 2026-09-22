import { prisma } from "@/lib/prisma";
import { isSuperuser } from "@/lib/env";
import { logger } from "@/lib/logger";
import { mintServerSideOtpSession } from "@/lib/auth/server-otp";
import { resolveLinkedStudent } from "@/lib/auth/student-link";
import {
  consumeNotificationLinkToken,
  type NotificationLinkKind,
  type NotificationLinkPayload,
} from "@/lib/auth/notification-link";

const log = logger({ surface: "notification-link" });

// Redeems a notification sign-in link (lib/auth/notification-link.ts) — the
// POST half of `/r/re/<token>` and `/r/ml/<token>`. The GET half only renders a
// button, because mail and chat link scanners fetch every link they see.
//
// Outcomes, in the order they are decided:
//   * `expired`  — the token is unknown, used, lapsed, or no longer matches the
//                  row it was issued for. One page for all of them: the reader
//                  cannot act on the difference, and a finer answer would
//                  describe the check.
//   * `sign-in`  — the link was valid, but the address is not one this route
//                  may sign in: it belongs to a teacher or an admin, or the
//                  student has been disabled. Those accounts go through the
//                  ordinary sign-in, where their own gates apply.
//   * `unavailable` — minting the session failed.
//   * `signed-in` — session cookie set; redirect to `redirectTo`.
export type NotificationLinkOutcome =
  | { code: "signed-in"; redirectTo: string }
  | { code: "expired" }
  | { code: "sign-in" }
  | { code: "unavailable" };

export async function redeemNotificationLink(input: {
  kind: NotificationLinkKind;
  token: string;
  headers: Headers;
  now?: Date;
}): Promise<NotificationLinkOutcome> {
  const consumed = await consumeNotificationLinkToken(prisma, input.kind, input.token, input.now);
  if (!consumed.ok) return { code: "expired" };
  const link = consumed.payload;

  const student = await prisma.student.findFirst({
    where: { id: link.studentId },
    select: { id: true, email: true, disabledAt: true },
  });
  // The row's address must still be the one the link was sent to. A student
  // who changed her email since has a link addressed to someone she no longer is.
  if (!student?.email || student.email.trim().toLowerCase() !== link.email) {
    return { code: "expired" };
  }

  const redirectTo = await resolveDestination(input.kind, link, student.id);
  if (!redirectTo) return { code: "expired" };

  if (student.disabledAt || (await belongsToStaffOrTeacher(student.email))) {
    return { code: "sign-in" };
  }

  let session: Awaited<ReturnType<typeof mintServerSideOtpSession>>;
  try {
    session = await mintServerSideOtpSession(student.email, input.headers);
  } catch (error) {
    log.warn("mintServerSideOtpSession failed", { error, kind: input.kind });
    return { code: "unavailable" };
  }

  // Minting a session is not the same as being recognised as a student: a
  // Student row created by checkout carries no authUserId until a sign-in path
  // claims it. Delegated to the shared resolver so "oldest unlinked roster row
  // wins" and Teacher/Student exclusivity stay in one place. A failure here
  // must not undo a valid sign-in — requireStudent retries the link.
  const authUser = session?.user;
  if (authUser?.id) {
    try {
      const linked = await resolveLinkedStudent({ id: authUser.id, email: authUser.email });
      if (linked.status !== "linked") {
        log.warn("notification sign-in did not resolve a student row", {
          kind: input.kind,
          status: linked.status,
        });
      }
    } catch (error) {
      log.error("resolveLinkedStudent failed after notification sign-in", error, {
        kind: input.kind,
      });
    }
  }

  return { code: "signed-in", redirectTo };
}

// The link names one booking or one notification. It still has to belong to
// the student the link was issued to, or there is nowhere to send her.
async function resolveDestination(
  kind: NotificationLinkKind,
  link: NotificationLinkPayload,
  studentId: string,
): Promise<string | null> {
  if (kind === "rebook") {
    const booking = await prisma.booking.findFirst({
      where: { id: link.subjectId, studentId },
      select: { packageId: true },
    });
    if (!booking) return null;
    // The canceled booking's own reschedule page redirects away for a status
    // that is no longer `scheduled`, so the book page is the destination, with
    // the credit pool the canceled class came from pre-selected.
    return `/my-classes/book?packageId=${encodeURIComponent(booking.packageId)}`;
  }

  // tenancy-exempt: the teacher is not known until this row is read; recipientId pins it to the one student the link was issued to.
  const notification = await prisma.notification.findFirst({
    where: {
      id: link.subjectId,
      templateName: "magic_link",
      recipientType: "student",
      recipientId: studentId,
    },
    select: { teacherId: true },
  });
  if (!notification) return null;
  const pairing = await prisma.teacherStudent.findFirst({
    where: { teacherId: notification.teacherId, studentId },
    select: { studentId: true },
  });
  return pairing ? "/my-classes" : null;
}

// A teacher's or an admin's address never signs in through a notification
// link. Both kinds of account have their own sign-in with its own gates
// (onboarding, the admin step-up), and a link written for a student must not
// step around them.
async function belongsToStaffOrTeacher(email: string): Promise<boolean> {
  if (isSuperuser(email)) return true;
  const insensitive = { equals: email, mode: "insensitive" as const };
  const admin = await prisma.adminUser.findFirst({
    where: { email: insensitive },
    select: { id: true },
  });
  if (admin) return true;
  const users = await prisma.user.findMany({
    where: { email: insensitive },
    select: { id: true },
  });
  const teacher = await prisma.teacher.findFirst({
    where: { OR: [{ email: insensitive }, { id: { in: users.map((u) => u.id) } }] },
    select: { id: true },
  });
  return Boolean(teacher);
}
