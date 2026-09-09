import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Secret tokens for the read-only iCal subscription feed
// (/api/calendar/feed/<token>.ics).
//
// Unlike the HMAC opt-out tokens (lib/email/opt-out-token.ts), these are
// per-user RANDOM values persisted on the row. That's deliberate: a calendar
// subscription URL is long-lived (a client polls it for years), so it must be
// revocable on its own — regenerating the token instantly kills a leaked URL
// without rotating SESSION_SECRET for everyone. A role prefix lets the feed
// route pick the right table from the token alone, avoiding a double lookup.

const TEACHER_PREFIX = "tch_";
const STUDENT_PREFIX = "stu_";

export type FeedOwner = { kind: "teacher"; id: string } | { kind: "student"; id: string };

function mintToken(prefix: string): string {
  return prefix + randomBytes(24).toString("base64url");
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Identify which table a token belongs to without touching the DB. */
export function feedTokenRole(token: string): "teacher" | "student" | null {
  if (token.startsWith(TEACHER_PREFIX)) return "teacher";
  if (token.startsWith(STUDENT_PREFIX)) return "student";
  return null;
}

export async function getOrCreateTeacherFeedToken(teacherId: string): Promise<string> {
  const row = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { calendarFeedToken: true },
  });
  if (row?.calendarFeedToken) return row.calendarFeedToken;
  return rotateTeacherFeedToken(teacherId);
}

export async function rotateTeacherFeedToken(teacherId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = mintToken(TEACHER_PREFIX);
    try {
      await prisma.teacher.update({ where: { id: teacherId }, data: { calendarFeedToken: token } });
      return token;
    } catch (err) {
      if (isUniqueViolation(err)) continue; // astronomically unlikely; retry
      throw err;
    }
  }
  throw new Error("Could not allocate a unique calendar feed token");
}

export async function getOrCreateStudentFeedToken(studentId: string): Promise<string> {
  const row = await prisma.student.findUnique({
    where: { id: studentId },
    select: { calendarFeedToken: true },
  });
  if (row?.calendarFeedToken) return row.calendarFeedToken;
  return rotateStudentFeedToken(studentId);
}

export async function rotateStudentFeedToken(studentId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = mintToken(STUDENT_PREFIX);
    try {
      await prisma.student.update({ where: { id: studentId }, data: { calendarFeedToken: token } });
      return token;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a unique calendar feed token");
}

/** Resolve a feed token to its owner, or null when unknown/malformed. */
export async function resolveFeedOwner(token: string): Promise<FeedOwner | null> {
  const role = feedTokenRole(token);
  if (role === "teacher") {
    const t = await prisma.teacher.findUnique({
      where: { calendarFeedToken: token },
      select: { id: true },
    });
    return t ? { kind: "teacher", id: t.id } : null;
  }
  if (role === "student") {
    const s = await prisma.student.findUnique({
      where: { calendarFeedToken: token },
      select: { id: true },
    });
    return s ? { kind: "student", id: s.id } : null;
  }
  return null;
}
