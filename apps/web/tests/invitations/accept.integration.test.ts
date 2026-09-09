import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { provisionInvitation as provisionInvitationImpl } from "@/lib/invitations/manage";
import { acceptInvitation as acceptInvitationImpl } from "@/lib/invitations/accept";

// Real-DB proof of acceptance: idempotency, email-match hijack guard, expiry,
// cancellation, existing-account linking, and Teacher/Student mutual exclusion.
//
// Both lib functions default their `db` param to the app's real `@/lib/prisma`
// singleton, which resolves DATABASE_URL to the CI job's unreachable stub
// (localhost:9999) — see test-db.ts. Every call here MUST bind getTestPrisma()
// explicitly, the same way every other *.integration.test.ts does; these two
// thin wrappers are the only call sites, so the bind lives in one place.
const provisionInvitation: typeof provisionInvitationImpl = (input) =>
  provisionInvitationImpl(input, getTestPrisma());
const acceptInvitation: typeof acceptInvitationImpl = (input) =>
  acceptInvitationImpl(input, getTestPrisma());

const TEACHER_ID = "55555555-5555-4555-8555-555555555555";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTeacher() {
  await ensureAuthUser(TEACHER_ID, "accept-teacher@e2e.test");
  await getTestPrisma().teacher.create({
    data: {
      id: TEACHER_ID,
      email: "accept-teacher@e2e.test",
      name: "Accept Teacher",
      timezone: "America/Mexico_City",
      bookingSlug: "accept-teacher",
    },
  });
}

async function invite(email: string) {
  const res = await provisionInvitation({ teacherId: TEACHER_ID, email, name: null });
  if (res.status !== "created") throw new Error(`setup: ${res.status}`);
  // Mark sent so time-to-accept has a reference.
  await getTestPrisma().studentInvitation.update({
    where: { id: res.invitation.id },
    data: { sentAt: new Date() },
  });
  return res;
}

describeIntegration("invitation accept (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedTeacher();
  });

  it("links the account, clears the hold, and marks accepted", async () => {
    const prisma = getTestPrisma();
    const { rawToken, studentId } = await invite("s@e2e.test");
    const userId = "66666666-6666-4666-8666-666666666666";
    await ensureAuthUser(userId, "s@e2e.test");

    const res = await acceptInvitation({ rawToken, user: { id: userId, email: "s@e2e.test" } });
    expect(res.status).toBe("accepted");
    // First-ever link for this identity — the invitation_accepted branch,
    // not invitation_existing_account_linked.
    if (res.status === "accepted") expect(res.existingAccount).toBe(false);

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    expect(student?.authUserId).toBe(userId);
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: TEACHER_ID, studentId } },
    });
    expect(link?.onboardingHoldAt).toBeNull();
    const inv = await prisma.studentInvitation.findFirst({
      where: { studentId, status: "accepted" },
    });
    expect(inv?.acceptedByUserId).toBe(userId);
  });

  it("is idempotent for the same user", async () => {
    const { rawToken } = await invite("idem@e2e.test");
    const userId = "77777777-7777-4777-8777-777777777777";
    await ensureAuthUser(userId, "idem@e2e.test");
    const first = await acceptInvitation({
      rawToken,
      user: { id: userId, email: "idem@e2e.test" },
    });
    const second = await acceptInvitation({
      rawToken,
      user: { id: userId, email: "idem@e2e.test" },
    });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    if (second.status === "accepted") expect(second.alreadyAccepted).toBe(true);
  });

  it("refuses a mismatched inbox (hijack guard)", async () => {
    const { rawToken } = await invite("owner@e2e.test");
    const attackerId = "88888888-8888-4888-8888-888888888888";
    await ensureAuthUser(attackerId, "attacker@e2e.test");
    const res = await acceptInvitation({
      rawToken,
      user: { id: attackerId, email: "attacker@e2e.test" },
    });
    expect(res.status).toBe("email_mismatch");
  });

  it("rejects a used token for a different account (accepted_by_other)", async () => {
    const { rawToken } = await invite("shared@e2e.test");
    const u1 = "99999999-9999-4999-8999-999999999999";
    await ensureAuthUser(u1, "shared@e2e.test");
    await acceptInvitation({ rawToken, user: { id: u1, email: "shared@e2e.test" } });
    // A different user id presenting the same (now-accepted) token. The auth
    // row needs its OWN email — User.email is @@unique, so a real second
    // account could never share u1's row-level email — but the claimed
    // identity passed into acceptInvitation is "shared@e2e.test" regardless,
    // matching the invited inbox (the hijack guard checks input.user.email,
    // never the User table), which is what this test needs to exercise.
    const u2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await ensureAuthUser(u2, "shared-other@e2e.test");
    const res = await acceptInvitation({ rawToken, user: { id: u2, email: "shared@e2e.test" } });
    expect(res.status).toBe("accepted_by_other");
  });

  it("rejects an expired invitation", async () => {
    const prisma = getTestPrisma();
    const { rawToken, invitation } = await invite("exp@e2e.test");
    await prisma.studentInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await ensureAuthUser(userId, "exp@e2e.test");
    const res = await acceptInvitation({ rawToken, user: { id: userId, email: "exp@e2e.test" } });
    expect(res.status).toBe("expired");
  });

  it("rejects a cancelled invitation", async () => {
    const prisma = getTestPrisma();
    const { rawToken, invitation } = await invite("can@e2e.test");
    await prisma.studentInvitation.update({
      where: { id: invitation.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await ensureAuthUser(userId, "can@e2e.test");
    const res = await acceptInvitation({ rawToken, user: { id: userId, email: "can@e2e.test" } });
    expect(res.status).toBe("cancelled");
  });

  it("rejects an invalid token", async () => {
    const res = await acceptInvitation({
      rawToken: "totally-unknown-but-well-formed-token-abcdef",
      user: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", email: "x@e2e.test" },
    });
    expect(res.status).toBe("invalid");
  });

  it("flags existingAccount when the identity already has a linked Student row (a second teacher's invite)", async () => {
    const prisma = getTestPrisma();
    const secondTeacherId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await ensureAuthUser(secondTeacherId, "second-teacher@e2e.test");
    await prisma.teacher.create({
      data: {
        id: secondTeacherId,
        email: "second-teacher@e2e.test",
        name: "Second Teacher",
        timezone: "America/Mexico_City",
        bookingSlug: "second-teacher",
      },
    });

    const userId = "12121212-1212-4121-8121-121212121212";
    await ensureAuthUser(userId, "multi@e2e.test");

    // First teacher's invite: fresh link, existingAccount is false.
    const first = await invite("multi@e2e.test");
    const firstResult = await acceptInvitation({
      rawToken: first.rawToken,
      user: { id: userId, email: "multi@e2e.test" },
    });
    expect(firstResult.status).toBe("accepted");
    if (firstResult.status === "accepted") expect(firstResult.existingAccount).toBe(false);

    // Second teacher's invite to the SAME inbox: the identity already owns a
    // linked Student row from the first teacher, so resolveLinkedStudent's
    // fast (authUserId) path wins — this is the "existing account" case
    // invitation_existing_account_linked exists for.
    const secondInviteRes = await provisionInvitation({
      teacherId: secondTeacherId,
      email: "multi@e2e.test",
      name: null,
    });
    if (secondInviteRes.status !== "created") throw new Error(`setup: ${secondInviteRes.status}`);
    const secondResult = await acceptInvitation({
      rawToken: secondInviteRes.rawToken,
      user: { id: userId, email: "multi@e2e.test" },
    });
    expect(secondResult.status).toBe("accepted");
    if (secondResult.status === "accepted") {
      expect(secondResult.existingAccount).toBe(true);
      expect(secondResult.alreadyAccepted).toBe(false);
    }
  });

  it("refuses when the accepting identity owns a Teacher row (is_teacher)", async () => {
    // Invite an email, then make that same auth id a teacher → mutual exclusion.
    const { rawToken } = await invite("dual@e2e.test");
    const dualId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await ensureAuthUser(dualId, "dual@e2e.test");
    await getTestPrisma().teacher.create({
      data: {
        id: dualId,
        email: "dual@e2e.test",
        name: "Dual",
        timezone: "America/Mexico_City",
        bookingSlug: "dual-teacher",
      },
    });
    const res = await acceptInvitation({ rawToken, user: { id: dualId, email: "dual@e2e.test" } });
    expect(res.status).toBe("is_teacher");
  });
});
