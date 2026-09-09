import type { Student } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeE164 } from "@/lib/phone";
import { trackServerEvent } from "@/lib/analytics/posthog";

// Shared mutation path for editing a student's contact card (name, email,
// WhatsApp number, timezone). All surfaces — the student's own account page
// (web + mobile) and the teacher's roster fix — funnel through here so the
// consent stamping, the email guard and the audit trail can't drift apart.
//
// Email rules:
//   * Only a teacher can set it, and only while the student has never
//     signed in (authUserId null). Once linked, the row's email must move
//     in lockstep with the better-auth user (lib/students/email-change.ts's
//     verified change flow, or its self-heal syncStudentEmailFromAuth), or
//     the student's next sign-in mints a fresh user that can never
//     re-attach to this row — so it's locked here.
//   * Stored lowercased: better-auth normalizes emails to lowercase and
//     resolveLinkedStudent links rows by exact match, so mixed case on the
//     row would break first sign-in.

export type ContactChangeActor = { type: "student" } | { type: "teacher"; teacherId: string };

export type StudentContactPatch = {
  name?: string;
  // Teacher-only. Never cleared through this path — an empty form field
  // means "leave as is" and the callers drop it before building the patch.
  email?: string;
  // `null` clears the number. This is the raw form input, normalized below —
  // despite the field name it isn't E.164 yet when it arrives here.
  phoneE164?: string | null;
  // ISO-3166-1 alpha-2 hint for resolving a bare national-format phoneE164 —
  // the country picked next to the phone field (student self-edit) or the
  // acting teacher's own country (roster edit). Ignored when phoneE164 is
  // absent/null.
  phoneCountry?: string;
  timezone?: string;
};

export type ContactUpdateError = "not-found" | "email-locked" | "email-taken";

export type ContactUpdateResult =
  { ok: true; changed: string[]; student: Student } | { ok: false; error: ContactUpdateError };

export async function applyStudentContactUpdate(input: {
  studentId: string;
  actor: ContactChangeActor;
  patch: StudentContactPatch;
}): Promise<ContactUpdateResult> {
  const { studentId, actor, patch } = input;

  // Tenancy: a teacher can only touch students on her own roster.
  const student = await prisma.student.findFirst({
    where:
      actor.type === "teacher"
        ? { id: studentId, teacherStudents: { some: { teacherId: actor.teacherId } } }
        : { id: studentId },
  });
  if (!student) return { ok: false, error: "not-found" };

  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const change = (field: string, from: unknown, to: unknown) => {
    data[field] = to;
    before[field] = from;
    after[field] = to;
  };

  if (patch.name !== undefined && patch.name !== student.name) {
    change("name", student.name, patch.name);
  }

  if (patch.timezone !== undefined && patch.timezone !== student.timezone) {
    change("timezone", student.timezone, patch.timezone);
  }

  if (patch.email !== undefined) {
    const email = patch.email.trim().toLowerCase();
    if (email !== student.email) {
      if (actor.type !== "teacher" || student.authUserId) {
        return { ok: false, error: "email-locked" };
      }
      // Checkout dedupes by (email + teacher), so two students of the same
      // teacher sharing an email would make future purchases land on an
      // arbitrary row. Cross-teacher duplicates stay allowed by design.
      const collision = await prisma.student.findFirst({
        where: {
          email,
          id: { not: studentId },
          teacherStudents: { some: { teacherId: actor.teacherId } },
        },
        select: { id: true },
      });
      if (collision) return { ok: false, error: "email-taken" };
      change("email", student.email, email);
    }
  }

  if (patch.phoneE164 !== undefined) {
    const number =
      patch.phoneE164 === null ? null : normalizeE164(patch.phoneE164, patch.phoneCountry);
    if (number !== student.phoneE164) {
      change("phoneE164", student.phoneE164, number);
    }
  }

  const changed = Object.keys(after);
  if (changed.length === 0) return { ok: true, changed, student };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.student.update({ where: { id: studentId }, data });
    await tx.studentContactChange.create({
      data: {
        studentId,
        actorType: actor.type,
        actorTeacherId: actor.type === "teacher" ? actor.teacherId : null,
        beforeJson: before as object,
        afterJson: after as object,
      },
    });
    return row;
  });

  trackServerEvent({
    name: "student_contact_updated",
    distinctId: actor.type === "teacher" ? actor.teacherId : studentId,
    properties: {
      studentId,
      actorType: actor.type,
      fields: changed,
      ...(actor.type === "teacher" ? { teacherId: actor.teacherId } : {}),
    },
  });

  return { ok: true, changed, student: updated };
}
