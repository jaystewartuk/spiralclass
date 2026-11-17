import type { PrismaClient } from "@prisma/client";
import { verifyEmailOptOutToken } from "./opt-out-token";

// Pure-handler-takes-deps split for the email opt-out redirect. The
// route lives in src/app/r/email-uns/[token]/route.ts; this is the
// testable inner surface.

export type EmailOptOutDeps = {
  prisma: Pick<PrismaClient, "teacherStudent" | "student">;
  secret: string;
  now?: () => Date;
};

export type EmailOptOutOutcome =
  | { code: "ok"; idempotent: boolean; studentId: string; teacherId: string }
  | { code: "invalid-token"; reason: string }
  | { code: "not-found" };

export async function applyEmailOptOut(
  deps: EmailOptOutDeps,
  token: string,
): Promise<EmailOptOutOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const verified = verifyEmailOptOutToken(token, deps.secret, now);
  if (!verified.ok) {
    return { code: "invalid-token", reason: verified.reason };
  }
  const { studentId, teacherId } = verified.payload;

  const member = await deps.prisma.teacherStudent.findUnique({
    where: {
      teacherId_studentId: { teacherId, studentId },
    },
    select: { teacherId: true },
  });
  if (!member) return { code: "not-found" };

  const before = await deps.prisma.student.findUnique({
    where: { id: studentId },
    select: { emailOptIn: true, email: true },
  });
  const wasOptedIn = before?.emailOptIn ?? true;

  // The unsubscribe describes the MAILBOX, not one roster row: the click
  // came from the inbox, so every same-email Student row (multi-teacher
  // identity set, moderated rows included) stops receiving email — one
  // click must not leave a sibling row still mailing the address that
  // just unsubscribed. See lib/students/identity.ts for the scope rules.
  //
  // `emailOptInAt` records when consent was withdrawn (#155) — stamped only
  // on a row this click actually flips, so a second click keeps the date of
  // the first.
  await deps.prisma.student.update({
    where: { id: studentId },
    data: wasOptedIn ? { emailOptIn: false, emailOptInAt: now } : { emailOptIn: false },
  });
  if (before?.email) {
    await deps.prisma.student.updateMany({
      where: {
        email: { equals: before.email, mode: "insensitive" },
        id: { not: studentId },
        emailOptIn: true,
      },
      data: { emailOptIn: false, emailOptInAt: now },
    });
  }

  return {
    code: "ok",
    idempotent: !wasOptedIn,
    studentId,
    teacherId,
  };
}
