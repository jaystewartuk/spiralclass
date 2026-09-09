import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import {
  cancelInvitation as cancelInvitationImpl,
  provisionInvitation as provisionInvitationImpl,
  rotateInvitationForResend as rotateInvitationForResendImpl,
} from "@/lib/invitations/manage";
import { hashInvitationToken } from "@/lib/invitations/token";

// Real-DB proof of the invitation lifecycle: provisioning creates/reuses the
// roster student, enforces one-active-per-email + mutual exclusivity, and
// resend/cancel behave. Complements the pure unit tests.
//
// All three lib functions default their `db` param to the app's real
// `@/lib/prisma` singleton, which resolves DATABASE_URL to the CI job's
// unreachable stub (localhost:9999) — see test-db.ts. Every call here MUST
// bind getTestPrisma() explicitly, the same way every other
// *.integration.test.ts does; these three thin wrappers are the only call
// sites, so the bind lives in one place.
const provisionInvitation: typeof provisionInvitationImpl = (input) =>
  provisionInvitationImpl(input, getTestPrisma());
const rotateInvitationForResend: typeof rotateInvitationForResendImpl = (teacherId, invitationId) =>
  rotateInvitationForResendImpl(teacherId, invitationId, getTestPrisma());
const cancelInvitation: typeof cancelInvitationImpl = (teacherId, invitationId) =>
  cancelInvitationImpl(teacherId, invitationId, getTestPrisma());

const TEACHER_ID = "22222222-2222-4222-8222-222222222222";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTeacher() {
  await ensureAuthUser(TEACHER_ID, "invite-teacher@e2e.test");
  await getTestPrisma().teacher.create({
    data: {
      id: TEACHER_ID,
      email: "invite-teacher@e2e.test",
      name: "Invite Teacher",
      timezone: "America/Mexico_City",
      bookingSlug: "invite-teacher",
    },
  });
}

describeIntegration("invitation manage (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedTeacher();
  });

  it("provisions a new roster student + pending invitation", async () => {
    const prisma = getTestPrisma();
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "new@e2e.test",
      name: "New",
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(res.createdStudent).toBe(true);

    const student = await prisma.student.findUnique({ where: { id: res.studentId } });
    expect(student?.email).toBe("new@e2e.test");
    // Staged silently until acceptance.
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: TEACHER_ID, studentId: res.studentId } },
    });
    expect(link?.onboardingHoldAt).not.toBeNull();

    // Token hash is stored, raw token is not.
    const inv = await prisma.studentInvitation.findUnique({ where: { id: res.invitation.id } });
    expect(inv?.tokenHash).toBe(hashInvitationToken(res.rawToken));
    expect(inv?.status).toBe("pending");
  });

  it("reuses an existing roster student", async () => {
    const prisma = getTestPrisma();
    const student = await prisma.student.create({
      data: {
        email: "existing@e2e.test",
        name: "Existing",
        teacherStudents: { create: { teacherId: TEACHER_ID } },
      },
    });
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "existing@e2e.test",
      name: null,
    });
    expect(res.status).toBe("created");
    if (res.status === "created") expect(res.studentId).toBe(student.id);
  });

  it("defaults a new roster student's locale to the column default, not es-MX", async () => {
    const prisma = getTestPrisma();
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "loc@e2e.test",
      name: null,
    });
    if (res.status !== "created") throw new Error("setup");
    const student = await prisma.student.findUnique({ where: { id: res.studentId } });
    expect(student?.locale).toBe("en");
    expect(res.studentLocale).toBe("en");
  });

  it("honours an explicit locale on a new roster student", async () => {
    const prisma = getTestPrisma();
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "loc-es@e2e.test",
      name: null,
      locale: "es-MX",
    });
    if (res.status !== "created") throw new Error("setup");
    expect((await prisma.student.findUnique({ where: { id: res.studentId } }))?.locale).toBe(
      "es-MX",
    );
    expect(res.studentLocale).toBe("es-MX");
  });

  it("reports an EXISTING roster student's own locale, so the invite email follows it", async () => {
    // The regression: a CSV-imported student stamped es-MX (or an English
    // student on a Spanish-dashboard teacher) got the invite in the TEACHER's
    // language, because the send path never looked at the roster row at all.
    const prisma = getTestPrisma();
    await prisma.student.create({
      data: {
        email: "english@e2e.test",
        name: "English Speaker",
        locale: "en",
        teacherStudents: { create: { teacherId: TEACHER_ID } },
      },
    });
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "english@e2e.test",
      name: null,
      // Even with an explicit es-MX for NEW rows, an existing row wins.
      locale: "es-MX",
    });
    if (res.status !== "created") throw new Error("setup");
    expect(res.createdStudent).toBe(false);
    expect(res.studentLocale).toBe("en");
  });

  it("resend reports the student's locale so it renders like the first send", async () => {
    const prisma = getTestPrisma();
    await prisma.student.create({
      data: {
        email: "resend-loc@e2e.test",
        name: "Resend Locale",
        locale: "en",
        teacherStudents: { create: { teacherId: TEACHER_ID } },
      },
    });
    const created = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "resend-loc@e2e.test",
      name: null,
    });
    if (created.status !== "created") throw new Error("setup");
    const rotated = await rotateInvitationForResend(TEACHER_ID, created.invitation.id);
    expect(rotated.status).toBe("ok");
    if (rotated.status !== "ok") return;
    expect(rotated.studentLocale).toBe("en");
  });

  it("refuses when a second pending invitation is requested (already_pending)", async () => {
    await provisionInvitation({ teacherId: TEACHER_ID, email: "dup@e2e.test", name: null });
    const second = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "dup@e2e.test",
      name: null,
    });
    expect(second.status).toBe("already_pending");
  });

  it("returns already_connected when the roster student has a login", async () => {
    const prisma = getTestPrisma();
    const userId = "33333333-3333-4333-8333-333333333333";
    await ensureAuthUser(userId, "linked@e2e.test");
    await prisma.student.create({
      data: {
        email: "linked@e2e.test",
        name: "Linked",
        authUserId: userId,
        teacherStudents: { create: { teacherId: TEACHER_ID } },
      },
    });
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "linked@e2e.test",
      name: null,
    });
    expect(res.status).toBe("already_connected");
  });

  it("refuses a teacher's own email (teacher_conflict)", async () => {
    const res = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "invite-teacher@e2e.test",
      name: null,
    });
    expect(res.status).toBe("teacher_conflict");
  });

  it("resend rotates the token and clears the reminder flag", async () => {
    const prisma = getTestPrisma();
    const created = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "r@e2e.test",
      name: null,
    });
    if (created.status !== "created") throw new Error("setup");
    await prisma.studentInvitation.update({
      where: { id: created.invitation.id },
      data: { reminderSentAt: new Date() },
    });
    const rotated = await rotateInvitationForResend(TEACHER_ID, created.invitation.id);
    expect(rotated.status).toBe("ok");
    if (rotated.status !== "ok") return;
    expect(rotated.rawToken).not.toBe(created.rawToken);
    const inv = await prisma.studentInvitation.findUnique({ where: { id: created.invitation.id } });
    expect(inv?.tokenHash).toBe(hashInvitationToken(rotated.rawToken));
    expect(inv?.reminderSentAt).toBeNull();
  });

  it("cancel revokes a pending invitation and is idempotent", async () => {
    const prisma = getTestPrisma();
    const created = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "c@e2e.test",
      name: null,
    });
    if (created.status !== "created") throw new Error("setup");
    expect((await cancelInvitation(TEACHER_ID, created.invitation.id)).status).toBe("ok");
    const inv = await prisma.studentInvitation.findUnique({ where: { id: created.invitation.id } });
    expect(inv?.status).toBe("cancelled");
    // Idempotent.
    expect((await cancelInvitation(TEACHER_ID, created.invitation.id)).status).toBe("ok");
  });

  it("scopes actions to the owning teacher", async () => {
    const created = await provisionInvitation({
      teacherId: TEACHER_ID,
      email: "scoped@e2e.test",
      name: null,
    });
    if (created.status !== "created") throw new Error("setup");
    const otherTeacher = "44444444-4444-4444-8444-444444444444";
    expect((await cancelInvitation(otherTeacher, created.invitation.id)).status).toBe("not_found");
  });
});
