import { prisma } from "@/lib/prisma";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";

const log = logger({ surface: "auth" });

/**
 * Emit `teacher_signed_in` for each new session (wired into the better-auth
 * `session.create.after` hook). Every session goes through ONE `session`
 * table, so this single hook is the returning-sign-in signal.
 *
 * `Teacher.id === the auth User.id` (teacher rows are provisioned with
 * `id: user.id`; see `requireTeacher`), so keying the event on `teacher.id`
 * resolves to the exact same PostHog Person every other teacher event uses.
 * Students / admins have no teacher row and don't emit here.
 *
 * The signup session fires this hook BEFORE the teacher row is lazily
 * provisioned, so the lookup misses and first sign-in stays a
 * `teacher_signup_completed` — the two never double-count.
 *
 * Best-effort by contract: analytics must never block or break authentication,
 * so every failure is swallowed.
 */
export async function trackTeacherSignIn(userId: string): Promise<void> {
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!teacher) return;
    trackServerEvent({
      name: "teacher_signed_in",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id },
    });
  } catch (err) {
    log.warn("trackTeacherSignIn failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
