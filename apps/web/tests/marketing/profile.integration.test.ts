import { beforeEach, expect, it, vi } from "vitest";
import { buildTeacherContext } from "@/lib/marketing/profile";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

vi.mock("server-only", () => ({}));

// Real-DB port of the shape the mocked `profile.test.ts` suite can't cover:
// that suite stubs `prisma.packageTemplate.findMany` directly, so a wrong
// field name in that query's `where`/`select` (real bug: `active` for
// `archived`, `classes` for `classCount` — D-125) is invisible to it. Only a
// real Prisma call — here, or production — validates the query against the
// actual schema. This is exactly what shipped broken: buildTeacherContext
// threw PrismaClientValidationError on both the Get Students page and every
// content-generation call, since both run through this one function.

const TEACHER_ID = "31111111-1111-4111-8111-111111111111";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

describeIntegration("buildTeacherContext (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
    await ensureAuthUser(TEACHER_ID, "profile-context@e2e.test");
    await getTestPrisma().teacher.create({
      data: {
        id: TEACHER_ID,
        email: "profile-context@e2e.test",
        name: "Profile Context Teacher",
        timezone: "America/Mexico_City",
        bookingSlug: "profile-context-teacher",
      },
    });
  });

  it("resolves non-archived package templates without throwing", async () => {
    const prisma = getTestPrisma();
    await prisma.packageTemplate.create({
      data: {
        teacherId: TEACHER_ID,
        name: "4 clases",
        classCount: 4,
        classDurationMin: 50,
        priceMinorUnits: 130_000,
        currency: "MXN",
      },
    });
    await prisma.packageTemplate.create({
      data: {
        teacherId: TEACHER_ID,
        name: "Retired package",
        classCount: 8,
        classDurationMin: 50,
        priceMinorUnits: 240_000,
        currency: "MXN",
        archived: true,
      },
    });

    const ctx = await buildTeacherContext(TEACHER_ID, getTestPrisma());

    expect(ctx).not.toBeNull();
    expect(ctx?.packages).toEqual([
      { name: "4 clases", classes: 4, priceMinorUnits: 130_000, currency: "MXN" },
    ]);
  });

  it("returns an empty package list rather than throwing when the teacher has none", async () => {
    const ctx = await buildTeacherContext(TEACHER_ID, getTestPrisma());
    expect(ctx?.packages).toEqual([]);
  });
});
