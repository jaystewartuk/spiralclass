import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// The `referrals` table's package_id/payment_id foreign keys (both ON DELETE
// CASCADE) were enforced by the pre-Neon raw-SQL migration but silently lost
// when the portable Postgres baseline was regenerated from schema.prisma —
// where those columns were modeled as bare @unique scalars with no @relation,
// so Prisma never emitted the constraints. The relations are now on model
// Referral and the FKs are restored in migration
// 20260714000000_restore_referrals_purchase_fks. This asserts the DB actually
// enforces them: a referral can't reference a nonexistent purchase, and a
// deleted package/payment cascades to its referral instead of orphaning it.
//
// Seeds through the better-auth `user` table (Teacher.id shares its PK — D-40),
// NOT the retired Supabase `auth.users` table.

const TEACHER_ID = "33333333-3333-4333-8333-cccccccccccc";

async function seedGraph() {
  const prisma = getTestPrisma();
  // better-auth user row: Teacher.id FKs to user.id (shared primary key).
  await prisma.$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1::uuid, 'Mira', 'teacher-fk@e2e.test', true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    TEACHER_ID,
  );
  const teacher = await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "teacher-fk@e2e.test",
      name: "Mira",
      timezone: "America/Mexico_City",
      bookingSlug: "teacher-fk",
    },
    select: { id: true },
  });
  const owner = await prisma.student.create({
    data: { email: "owner-fk@e2e.test", name: "Owner", locale: "es-MX" },
    select: { id: true },
  });
  const friend = await prisma.student.create({
    data: { email: "friend-fk@e2e.test", name: "Friend", locale: "es-MX" },
    select: { id: true },
  });
  await prisma.teacherStudent.createMany({
    data: [
      { teacherId: teacher.id, studentId: owner.id },
      { teacherId: teacher.id, studentId: friend.id },
    ],
  });
  const code = await prisma.referralCode.create({
    data: { teacherId: teacher.id, ownerStudentId: owner.id, code: "FRIEND10" },
    select: { id: true },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId: teacher.id,
      studentId: friend.id,
      classesTotal: 10,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date(),
    },
    select: { id: true },
  });
  const payment = await prisma.payment.create({
    data: { packageId: pkg.id, amountMinorUnits: 150_000, status: "paid" },
    select: { id: true },
  });
  const referral = await prisma.referral.create({
    data: {
      teacherId: teacher.id,
      referralCodeId: code.id,
      referredStudentId: friend.id,
      packageId: pkg.id,
      paymentId: payment.id,
      referredDiscountMinorUnits: 15_000,
    },
    select: { id: true },
  });
  return { teacher, owner, friend, code, pkg, payment, referral };
}

describeIntegration("referrals purchase FKs (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects a referral pointing at a nonexistent package", async () => {
    const prisma = getTestPrisma();
    const { referral } = await seedGraph();
    // Re-point package_id at a random, nonexistent package via raw SQL
    // (Prisma's typed API can't express a dangling FK). The FK must reject it.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "referrals" SET "package_id" = gen_random_uuid() WHERE "id" = $1::uuid`,
        referral.id,
      ),
    ).rejects.toThrow(/foreign key|referrals_package_id_fkey|violates/i);
  });

  it("rejects a referral pointing at a nonexistent payment", async () => {
    const prisma = getTestPrisma();
    const { referral } = await seedGraph();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "referrals" SET "payment_id" = gen_random_uuid() WHERE "id" = $1::uuid`,
        referral.id,
      ),
    ).rejects.toThrow(/foreign key|referrals_payment_id_fkey|violates/i);
  });

  it("cascades: deleting the package deletes its referral (no orphan)", async () => {
    const prisma = getTestPrisma();
    const { pkg, referral } = await seedGraph();
    await prisma.package.delete({ where: { id: pkg.id } });
    const survivor = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(survivor).toBeNull();
  });

  it("cascades: deleting the payment deletes its referral (no orphan)", async () => {
    const prisma = getTestPrisma();
    const { payment, referral } = await seedGraph();
    await prisma.payment.delete({ where: { id: payment.id } });
    const survivor = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(survivor).toBeNull();
  });
});
