import { beforeEach, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  CHECKOUT_PAYABLE_WINDOW_MS,
  resolveAndValidateDiscount,
  revalidateDiscountUnderLock,
} from "@/lib/discounts";
import { resolveReferralForCheckout, revalidateReferralUnderLock } from "@/lib/referrals";
import { supersedePendingCheckouts } from "@/lib/payments/supersede-pending";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// Issue #74. A redemption counted while its package was `pending`, and a card
// checkout that expired or was declined left its package `pending` for good
// (the webhook fails the Payment, never the Package). So a student whose card
// checkout failed was told she had already used the code, and the code's cap
// filled with checkouts nobody paid for. The cap was also read outside the
// transaction that wrote the redemption, so two checkouts at once could both
// take the last use.
//
// Real Postgres, because both halves are query semantics: a relation filter
// the in-memory fakes cannot evaluate, and a row lock they cannot take.

const TEACHER_ID = "74747474-7474-4747-8747-747474747474";
const NOW = new Date("2026-11-16T12:00:00Z");
const LONG_AGO = new Date(NOW.getTime() - CHECKOUT_PAYABLE_WINDOW_MS - 60_000);
const JUST_NOW = new Date(NOW.getTime() - 5 * 60_000);
const BASE = 100_000;

async function seedTeacher() {
  const prisma = getTestPrisma();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1::uuid, 'Rosa', 'teacher-74@e2e.test', true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    TEACHER_ID,
  );
  await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "teacher-74@e2e.test",
      name: "Rosa",
      timezone: "America/Mexico_City",
      bookingSlug: "teacher-74",
      stripeAccountId: "acct_teacher_74",
    },
  });
  const template = await prisma.packageTemplate.create({
    data: {
      teacherId: TEACHER_ID,
      name: "Ten classes",
      classCount: 10,
      classDurationMin: 50,
      priceMinorUnits: BASE,
    },
    select: { id: true },
  });
  return { templateId: template.id };
}

async function seedStudent(email: string) {
  const prisma = getTestPrisma();
  const student = await prisma.student.create({
    data: { email, name: email.split("@")[0]!, locale: "es" },
    select: { id: true },
  });
  await prisma.teacherStudent.create({ data: { teacherId: TEACHER_ID, studentId: student.id } });
  return student.id;
}

async function seedCode(opts: { maxRedemptions?: number | null; perStudentLimit?: number } = {}) {
  return getTestPrisma().discountCode.create({
    data: {
      teacherId: TEACHER_ID,
      code: "VERANO",
      kind: "percent",
      percentBps: 2000,
      maxRedemptions: opts.maxRedemptions ?? null,
      perStudentLimit: opts.perStudentLimit ?? 1,
    },
    select: { id: true },
  });
}

type PaymentSeed = {
  status: "pending" | "failed" | "paid";
  provider?: "stripe" | "manual_transfer";
  createdAt: Date;
};

// A package as the checkout leaves it, plus whatever the webhook did since.
async function seedPurchase(
  db: Prisma.TransactionClient,
  opts: {
    studentId: string;
    templateId?: string;
    packageStatus: "pending" | "active" | "expired";
    payment: PaymentSeed;
  },
) {
  const pkg = await db.package.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: opts.studentId,
      templateId: opts.templateId ?? null,
      classesTotal: 10,
      pricePaidMinorUnits: 80_000,
      purchasedAt: opts.payment.createdAt,
      status: opts.packageStatus,
    },
    select: { id: true },
  });
  const provider = opts.payment.provider ?? "stripe";
  const payment = await db.payment.create({
    data: {
      packageId: pkg.id,
      amountMinorUnits: 80_000,
      status: opts.payment.status,
      provider,
      createdAt: opts.payment.createdAt,
      ...(provider === "stripe" ? { stripeCheckoutSessionId: `cs_${pkg.id.slice(0, 8)}` } : {}),
    },
    select: { id: true },
  });
  return { packageId: pkg.id, paymentId: payment.id };
}

async function redeem(
  db: Prisma.TransactionClient,
  codeId: string,
  studentId: string,
  purchase: { packageId: string; paymentId: string },
) {
  await db.discountRedemption.create({
    data: {
      discountCodeId: codeId,
      teacherId: TEACHER_ID,
      studentId,
      packageId: purchase.packageId,
      paymentId: purchase.paymentId,
      amountMinorUnits: 20_000,
    },
  });
}

// Holds two concurrent checkouts between "checked the limit" and "wrote the
// redemption" — the window an unlocked read leaves open. Released when both
// arrive, or after a beat when one is held behind a lock: waiting forever would
// deadlock the locked (correct) case.
function twoWayBarrier() {
  let arrived = 0;
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === 2) release();
    return Promise.race([both, new Promise((r) => setTimeout(r, 500))]);
  };
}

function validate(studentId: string) {
  return resolveAndValidateDiscount({
    db: getTestPrisma(),
    teacherId: TEACHER_ID,
    studentId,
    code: "verano",
    baseMinorUnits: BASE,
    now: NOW,
  });
}

describeIntegration("discount and referral limits (real DB, issue #74)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("frees the student's use once her failed card checkout can no longer be paid", async () => {
    await seedTeacher();
    const student = await seedStudent("ana-74@e2e.test");
    const code = await seedCode();
    const purchase = await seedPurchase(getTestPrisma(), {
      studentId: student,
      packageStatus: "pending",
      payment: { status: "failed", createdAt: LONG_AGO },
    });
    await redeem(getTestPrisma(), code.id, student, purchase);

    expect(await validate(student)).toMatchObject({ ok: true, finalMinorUnits: 80_000 });
  });

  it("frees a use of the code's total cap held by someone else's dead checkout", async () => {
    await seedTeacher();
    const other = await seedStudent("otro-74@e2e.test");
    const student = await seedStudent("ana-74@e2e.test");
    const code = await seedCode({ maxRedemptions: 1 });
    const purchase = await seedPurchase(getTestPrisma(), {
      studentId: other,
      packageStatus: "pending",
      payment: { status: "failed", createdAt: LONG_AGO },
    });
    await redeem(getTestPrisma(), code.id, other, purchase);

    expect(await validate(student)).toMatchObject({ ok: true });
  });

  // The security half. A declined card leaves the Checkout Session open: the
  // student can try another card on it, and the payment goes failed → paid.
  // While that is possible the use must stay spent, or the same code could be
  // carried into a second checkout and both paid.
  it("still counts a declined card whose checkout can still be paid", async () => {
    await seedTeacher();
    const student = await seedStudent("ana-74@e2e.test");
    const code = await seedCode();
    const purchase = await seedPurchase(getTestPrisma(), {
      studentId: student,
      packageStatus: "pending",
      payment: { status: "failed", createdAt: JUST_NOW },
    });
    await redeem(getTestPrisma(), code.id, student, purchase);

    expect(await validate(student)).toEqual({ ok: false, reason: "per_student" });
  });

  it("still counts an unpaid checkout that is merely waiting (pending payment, any age)", async () => {
    // A pending payment may be a bank transfer in flight (D-145): its age says
    // nothing about whether money is coming.
    await seedTeacher();
    const student = await seedStudent("ana-74@e2e.test");
    const code = await seedCode();
    const purchase = await seedPurchase(getTestPrisma(), {
      studentId: student,
      packageStatus: "pending",
      payment: { status: "pending", createdAt: LONG_AGO },
    });
    await redeem(getTestPrisma(), code.id, student, purchase);

    expect(await validate(student)).toEqual({ ok: false, reason: "per_student" });
  });

  it("still counts a paid purchase", async () => {
    await seedTeacher();
    const student = await seedStudent("ana-74@e2e.test");
    const code = await seedCode();
    const purchase = await seedPurchase(getTestPrisma(), {
      studentId: student,
      packageStatus: "active",
      payment: { status: "paid", createdAt: LONG_AGO },
    });
    await redeem(getTestPrisma(), code.id, student, purchase);

    expect(await validate(student)).toEqual({ ok: false, reason: "per_student" });
  });

  it("lets a referred friend retry her first purchase after a failed card checkout", async () => {
    const prisma = getTestPrisma();
    await seedTeacher();
    const owner = await seedStudent("owner-74@e2e.test");
    const friend = await seedStudent("friend-74@e2e.test");
    await prisma.referralProgram.create({
      data: {
        teacherId: TEACHER_ID,
        enabled: true,
        referredAmountMinorUnits: 10_000,
        referrerAmountMinorUnits: 10_000,
      },
    });
    const refCode = await prisma.referralCode.create({
      data: { teacherId: TEACHER_ID, ownerStudentId: owner, code: "AMIGA74" },
      select: { id: true },
    });
    const purchase = await seedPurchase(prisma, {
      studentId: friend,
      packageStatus: "pending",
      payment: { status: "failed", createdAt: LONG_AGO },
    });
    await prisma.referral.create({
      data: {
        teacherId: TEACHER_ID,
        referralCodeId: refCode.id,
        referredStudentId: friend,
        packageId: purchase.packageId,
        paymentId: purchase.paymentId,
        referredDiscountMinorUnits: 10_000,
      },
    });

    const args = {
      db: prisma,
      teacherId: TEACHER_ID,
      studentId: friend,
      studentEmail: "friend-74@e2e.test",
      code: "amiga74",
      baseMinorUnits: BASE,
    };
    expect(await resolveReferralForCheckout({ ...args, now: NOW })).toMatchObject({ ok: true });
    // …but not while that checkout could still be paid.
    expect(
      await resolveReferralForCheckout({
        ...args,
        now: new Date(LONG_AGO.getTime() + 60 * 60_000),
      }),
    ).toEqual({ ok: false, reason: "already_redeemed" });
  });

  // The student comes straight back to the same package after a decline. The
  // new checkout supersedes the old one — expiring its session on Stripe, which
  // is what makes the old one unpayable — and only then is the code free.
  it("supersedes a declined checkout for the same package, freeing the code", async () => {
    const prisma = getTestPrisma();
    const { templateId } = await seedTeacher();
    const student = await seedStudent("ana-74@e2e.test");
    const code = await seedCode();
    const purchase = await seedPurchase(prisma, {
      studentId: student,
      templateId,
      packageStatus: "pending",
      payment: { status: "failed", createdAt: JUST_NOW },
    });
    await redeem(prisma, code.id, student, purchase);
    const expireCheckoutSession = vi.fn(async () => ({}) as never);

    const out = await supersedePendingCheckouts(
      { teacherId: TEACHER_ID, studentId: student, templateId },
      { prisma, getStripe: () => ({ expireCheckoutSession }) as never },
    );

    expect(out.superseded).toBe(1);
    expect(expireCheckoutSession).toHaveBeenCalledWith(
      `cs_${purchase.packageId.slice(0, 8)}`,
      "acct_teacher_74",
    );
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: purchase.packageId } });
    expect(pkg.status).toBe("expired");
    expect(await validate(student)).toMatchObject({ ok: true });
  });

  it("never supersedes a checkout that has been paid", async () => {
    const prisma = getTestPrisma();
    const { templateId } = await seedTeacher();
    const student = await seedStudent("ana-74@e2e.test");
    const purchase = await seedPurchase(prisma, {
      studentId: student,
      templateId,
      packageStatus: "pending",
      payment: { status: "paid", createdAt: JUST_NOW },
    });
    const expireCheckoutSession = vi.fn(async () => ({}) as never);

    const out = await supersedePendingCheckouts(
      { teacherId: TEACHER_ID, studentId: student, templateId },
      { prisma, getStripe: () => ({ expireCheckoutSession }) as never },
    );

    expect(out.superseded).toBe(0);
    expect(expireCheckoutSession).not.toHaveBeenCalled();
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: purchase.packageId } });
    expect(pkg.status).toBe("pending");
  });

  // Two students take the last use of a capped code at the same moment. Each
  // checkout transaction re-checks the limit and then writes its redemption;
  // the barrier holds both between the two steps, which is exactly the window
  // an unlocked read leaves open. With the code row locked, the second waits
  // for the first to commit and then sees the cap reached.
  it("cannot be pushed past maxRedemptions by concurrent checkouts", async () => {
    const prisma = getTestPrisma();
    await seedTeacher();
    const a = await seedStudent("a-74@e2e.test");
    const b = await seedStudent("b-74@e2e.test");
    const code = await seedCode({ maxRedemptions: 1 });
    const barrier = twoWayBarrier();

    const checkout = (studentId: string) =>
      prisma.$transaction(async (tx) => {
        const check = await revalidateDiscountUnderLock(tx, {
          codeId: code.id,
          teacherId: TEACHER_ID,
          studentId,
          code: "VERANO",
          baseMinorUnits: BASE,
          now: NOW,
        });
        await barrier();
        if (!check.ok) return check;
        const purchase = await seedPurchase(tx, {
          studentId,
          packageStatus: "pending",
          payment: { status: "pending", createdAt: NOW },
        });
        await redeem(tx, code.id, studentId, purchase);
        return check;
      });

    const results = await Promise.all([checkout(a), checkout(b)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "max_redemptions" }]);
    expect(await prisma.discountRedemption.count({ where: { discountCodeId: code.id } })).toBe(1);
  });

  it("cannot attribute two concurrent checkouts as one friend's first purchase", async () => {
    const prisma = getTestPrisma();
    await seedTeacher();
    const owner = await seedStudent("owner-74@e2e.test");
    const friend = await seedStudent("friend-74@e2e.test");
    await prisma.referralProgram.create({
      data: {
        teacherId: TEACHER_ID,
        enabled: true,
        referredAmountMinorUnits: 10_000,
        referrerAmountMinorUnits: 10_000,
      },
    });
    const refCode = await prisma.referralCode.create({
      data: { teacherId: TEACHER_ID, ownerStudentId: owner, code: "AMIGA74" },
      select: { id: true },
    });
    const barrier = twoWayBarrier();

    const checkout = () =>
      prisma.$transaction(async (tx) => {
        const check = await revalidateReferralUnderLock(tx, {
          teacherId: TEACHER_ID,
          studentId: friend,
          studentEmail: "friend-74@e2e.test",
          code: "AMIGA74",
          baseMinorUnits: BASE,
          now: NOW,
        });
        await barrier();
        if (!check.ok) return check;
        const purchase = await seedPurchase(tx, {
          studentId: friend,
          packageStatus: "pending",
          payment: { status: "pending", createdAt: NOW },
        });
        await tx.referral.create({
          data: {
            teacherId: TEACHER_ID,
            referralCodeId: refCode.id,
            referredStudentId: friend,
            packageId: purchase.packageId,
            paymentId: purchase.paymentId,
            referredDiscountMinorUnits: 10_000,
          },
        });
        return check;
      });

    const results = await Promise.all([checkout(), checkout()]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "already_redeemed" }]);
  });
});
