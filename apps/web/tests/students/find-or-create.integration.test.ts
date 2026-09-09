import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { findOrCreateRosterStudent } from "@/lib/students/find-or-create";

// The (teacher, email) → one-Student invariant can't be a DB constraint
// (email lives on students, tenancy on teacher_students), so the advisory
// lock inside findOrCreateRosterStudent is the only thing standing between
// a double-submitted checkout and a split roster identity. This exercises
// the race for real.

const TEACHER_A = "21111111-1111-4111-8111-111111111111";
const TEACHER_B = "22222222-2222-4222-8222-222222222222";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTeacher(id: string, slug: string) {
  await ensureAuthUser(id, `${slug}@e2e.test`);
  await getTestPrisma().teacher.create({
    data: {
      id,
      email: `${slug}@e2e.test`,
      name: slug,
      timezone: "America/Mexico_City",
      bookingSlug: slug,
    },
  });
}

describeIntegration("findOrCreateRosterStudent (real DB)", () => {
  beforeAll(async () => {
    await truncateAll();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedTeacher(TEACHER_A, "upsert-teacher-a");
  });

  it("10 concurrent checkouts for the same (teacher, email) produce exactly one student", async () => {
    const prisma = getTestPrisma();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        findOrCreateRosterStudent(
          {
            teacherId: TEACHER_A,
            email: "mira@gmail.com",
            name: `Mira intento ${i}`,
            phoneE164: null,
          },
          prisma,
        ),
      ),
    );

    const ids = new Set(results.map((s) => s.id));
    expect(ids.size).toBe(1);

    const rows = await prisma.student.findMany({ where: { email: "mira@gmail.com" } });
    expect(rows).toHaveLength(1);
    const links = await prisma.teacherStudent.findMany({
      where: { studentId: rows[0].id },
    });
    expect(links).toHaveLength(1);
  });

  it("a repeat checkout reuses the row and refreshes mutable fields", async () => {
    const prisma = getTestPrisma();
    const first = await findOrCreateRosterStudent(
      {
        teacherId: TEACHER_A,
        email: "carlos@gmail.com",
        name: "Carlos",
        phoneE164: null,
      },
      prisma,
    );
    const second = await findOrCreateRosterStudent(
      {
        teacherId: TEACHER_A,
        email: "carlos@gmail.com",
        name: "Carlos Ruiz",
        phoneE164: "+5215555000002",
      },
      prisma,
    );

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Carlos Ruiz");
    expect(second.phoneE164).toBe("+5215555000002");
  });

  it("the same email under a different teacher stays a separate row (multi-teacher tenancy)", async () => {
    const prisma = getTestPrisma();
    await seedTeacher(TEACHER_B, "upsert-teacher-b");

    const withA = await findOrCreateRosterStudent(
      {
        teacherId: TEACHER_A,
        email: "sofia@gmail.com",
        name: "Sofía",
        phoneE164: null,
      },
      prisma,
    );
    const withB = await findOrCreateRosterStudent(
      {
        teacherId: TEACHER_B,
        email: "sofia@gmail.com",
        name: "Sofía",
        phoneE164: null,
      },
      prisma,
    );

    expect(withB.id).not.toBe(withA.id);
    const rows = await prisma.student.findMany({ where: { email: "sofia@gmail.com" } });
    expect(rows).toHaveLength(2);
  });
});
