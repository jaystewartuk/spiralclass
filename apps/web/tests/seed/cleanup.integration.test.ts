import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { withOverridesDeletable } from "../../scripts/seed";

// Regression for the preview reseed break: the `overrides` audit table is
// append-only (a DELETE/UPDATE trigger guards it — the invariants migration,
// D-25). The seed's idempotent cleanup hard-deletes its teachers, and a teacher
// that accumulated audit rows on a long-lived env (Alicia Moreno, impersonated from
// /admin on preview) makes that cascade trip the trigger. `withOverridesDeletable`
// lifts the user trigger for the cleanup window so the wipe succeeds, then
// restores it. These tests run against the real test Postgres, which carries the
// trigger via `prisma migrate deploy`.
describeIntegration("seed cleanup vs the append-only overrides guard", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seedTeacherWithOverride(): Promise<string> {
    const prisma = getTestPrisma();
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      id,
      `cleanup-${id}@spiralclass.com`,
    );
    await prisma.teacher.create({
      data: {
        id,
        email: `cleanup-${id}@spiralclass.com`,
        name: "Cleanup Probe",
        timezone: "America/Mexico_City",
        bookingSlug: `cleanup-${id.slice(0, 8)}`,
      },
    });
    await prisma.override.create({
      data: {
        teacherId: id,
        targetType: "teacher",
        targetId: id,
        action: "seed_test",
        reason: "regression fixture",
      },
    });
    return id;
  }

  it("the guard blocks a naive cascade delete of a teacher with audit rows", async () => {
    const prisma = getTestPrisma();
    const id = await seedTeacherWithOverride();

    await expect(prisma.teacher.delete({ where: { id } })).rejects.toThrow(/append-only/);
    // The rejected delete leaves both rows intact.
    expect(await prisma.teacher.count({ where: { id } })).toBe(1);
    expect(await prisma.override.count({ where: { teacherId: id } })).toBe(1);
  });

  it("withOverridesDeletable wipes the teacher and cascades its audit rows", async () => {
    const prisma = getTestPrisma();
    const id = await seedTeacherWithOverride();

    await withOverridesDeletable(prisma, async (tx) => {
      await tx.teacher.deleteMany({ where: { id } });
    });

    expect(await prisma.teacher.count({ where: { id } })).toBe(0);
    expect(await prisma.override.count({ where: { teacherId: id } })).toBe(0);
  });

  it("restores the guard after the cleanup window closes", async () => {
    const prisma = getTestPrisma();
    const first = await seedTeacherWithOverride();
    await withOverridesDeletable(prisma, async (tx) => {
      await tx.teacher.deleteMany({ where: { id: first } });
    });

    // A fresh teacher's audit rows are protected again — the trigger is back.
    const second = await seedTeacherWithOverride();
    await expect(prisma.teacher.delete({ where: { id: second } })).rejects.toThrow(/append-only/);
  });
});
