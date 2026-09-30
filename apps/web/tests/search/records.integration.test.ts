import { beforeEach, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { teacherSearchRecords } from "@/lib/search/teacher-records";
import { studentSearchRecords } from "@/lib/search/student-records";

// The site-search index ships a person's records to her browser, so the one
// property that matters more than any ranking is that it contains nobody
// else's. There is no row-level security; the `where` in each query is the
// only isolation. Seed two tenants with a row of every indexed kind, build
// each one's index against real Postgres, and assert neither sees the other.

const TEACHER_A = "a1111111-1111-4111-8111-111111111111";
const TEACHER_B = "b2222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-30T12:00:00Z");

async function ensureUserRow(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTenant(teacherId: string, tag: string) {
  const prisma = getTestPrisma();
  await ensureUserRow(teacherId, `${tag}-teacher@e2e.test`);
  await prisma.teacher.create({
    data: {
      id: teacherId,
      email: `${tag}-teacher@e2e.test`,
      name: `Teacher ${tag}`,
      timezone: "America/Mexico_City",
      bookingSlug: tag,
    },
  });
  const student = await prisma.student.create({
    data: { email: `${tag}-student@e2e.test`, name: `Student ${tag}` },
    select: { id: true, email: true, timezone: true },
  });
  await prisma.teacherStudent.create({ data: { teacherId, studentId: student.id } });
  const template = await prisma.packageTemplate.create({
    data: { teacherId, name: `Package ${tag}`, classCount: 4, priceMinorUnits: 100_000 },
    select: { id: true },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId,
      studentId: student.id,
      templateId: template.id,
      classesTotal: 4,
      classDurationMin: 50,
      pricePaidMinorUnits: 100_000,
      purchasedAt: new Date("2026-09-01T00:00:00Z"),
      status: "active",
    },
    select: { id: true },
  });
  const booking = await prisma.booking.create({
    data: {
      packageId: pkg.id,
      teacherId,
      studentId: student.id,
      scheduledStart: new Date("2026-10-02T15:00:00Z"),
      scheduledEnd: new Date("2026-10-02T15:50:00Z"),
      status: "scheduled",
    },
    select: { id: true },
  });
  const lead = await prisma.lead.create({
    data: { teacherId, name: `Lead ${tag}`, email: `${tag}-lead@e2e.test` },
    select: { id: true },
  });
  const material = await prisma.libraryMaterial.create({
    data: { teacherId, label: `Material ${tag}` },
    select: { id: true },
  });
  return { student, templateId: template.id, bookingId: booking.id, leadId: lead.id, material };
}

describeIntegration("site-search records (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("a teacher's index holds every kind of her own record and nothing of another teacher's", async () => {
    const prisma = getTestPrisma();
    const a = await seedTenant(TEACHER_A, "alpha");
    const b = await seedTenant(TEACHER_B, "beta");

    const entries = await teacherSearchRecords(
      {
        teacher: { id: TEACHER_A, timezone: "America/Mexico_City" },
        locale: "en",
        t: createT("en"),
        now: NOW,
      },
      prisma,
    );
    const ids = entries.map((e) => e.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        `student.${a.student.id}`,
        `message.${a.student.id}`,
        `class.${a.bookingId}`,
        `package.${a.templateId}`,
        `lead.${a.leadId}`,
        `material.${a.material.id}`,
      ]),
    );
    const everything = JSON.stringify(entries);
    for (const theirs of [b.student.id, b.bookingId, b.templateId, b.leadId, b.material.id]) {
      expect(everything).not.toContain(theirs);
    }
    expect(everything).not.toContain("beta");
  });

  it("a student's index holds her own teacher and class and nothing of another student's", async () => {
    const prisma = getTestPrisma();
    const a = await seedTenant(TEACHER_A, "alpha");
    const b = await seedTenant(TEACHER_B, "beta");

    const entries = await studentSearchRecords(
      { student: a.student, locale: "en", t: createT("en"), now: NOW },
      prisma,
    );
    const ids = entries.map((e) => e.id);

    expect(ids).toEqual(expect.arrayContaining([`teacher.${TEACHER_A}`, `class.${a.bookingId}`]));
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain(TEACHER_B);
    expect(everything).not.toContain(b.bookingId);
  });
});
