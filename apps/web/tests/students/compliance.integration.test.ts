import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { studentComplianceIds, studentIdentityIds } from "@/lib/students/identity";
import {
  fileStudentDeletionRequests,
  cancelStudentDeletionRequests,
  pendingStudentDeletionRequest,
} from "@/lib/account-deletion/requests";
import { buildStudentIdentityExport } from "@/lib/account-deletion/export-data";

// Multi-teacher compliance coverage: deletion requests and data exports must
// reach EVERY Student row a person's data lives on — the auth-linked row
// plus same-email siblings under other teachers, moderated rows included —
// while the portal identity set keeps excluding moderated rows.

const TEACHER_A = "41111111-1111-4111-8111-111111111111";
const TEACHER_B = "42222222-2222-4222-8222-222222222222";
const EMAIL = "mira@gmail.com";

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

// One person, two teachers: linked row under A, sibling under B (mixed-case
// email to exercise the insensitive match), unrelated third student.
async function seedIdentityPair(opts?: { disableSibling?: boolean }) {
  const prisma = getTestPrisma();
  const linked = await prisma.student.create({
    data: {
      email: EMAIL,
      name: "Mira (con A)",
      teacherStudents: { create: { teacherId: TEACHER_A } },
    },
  });
  const sibling = await prisma.student.create({
    data: {
      email: "Mira@Gmail.com",
      name: "Mira (con B)",
      disabledAt: opts?.disableSibling ? new Date() : null,
      teacherStudents: { create: { teacherId: TEACHER_B } },
    },
  });
  const unrelated = await prisma.student.create({
    data: {
      email: "carlos@gmail.com",
      name: "Carlos",
      teacherStudents: { create: { teacherId: TEACHER_A } },
    },
  });
  return { linked, sibling, unrelated };
}

describeIntegration("multi-teacher compliance set (real DB)", () => {
  beforeAll(async () => {
    await truncateAll();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedTeacher(TEACHER_A, "compliance-teacher-a");
    await seedTeacher(TEACHER_B, "compliance-teacher-b");
  });

  it("compliance set includes moderated siblings; portal set excludes them", async () => {
    const prisma = getTestPrisma();
    const { linked, sibling } = await seedIdentityPair({ disableSibling: true });

    const compliance = await studentComplianceIds(linked, prisma);
    expect(new Set(compliance)).toEqual(new Set([linked.id, sibling.id]));

    const portal = await studentIdentityIds(linked, prisma);
    expect(portal).toEqual([linked.id]);
  });

  it("deletion request fans out to every identity row, idempotently, and cancel clears the set", async () => {
    const prisma = getTestPrisma();
    const { linked, sibling, unrelated } = await seedIdentityPair();
    const ids = await studentComplianceIds(linked, prisma);
    const scheduledFor = new Date(Date.now() + 30 * 24 * 3600_000);

    const first = await fileStudentDeletionRequests(
      { studentIds: ids, email: EMAIL, scheduledFor },
      prisma,
    );
    expect(first.created).toBe(2);

    // Re-filing while pending creates nothing (and doesn't trip the
    // one-pending-per-subject partial unique index).
    const second = await fileStudentDeletionRequests(
      { studentIds: ids, email: EMAIL, scheduledFor },
      prisma,
    );
    expect(second.created).toBe(0);

    const pendingRows = await prisma.accountDeletionRequest.findMany({
      where: { status: "pending" },
      select: { subjectId: true },
    });
    expect(new Set(pendingRows.map((r) => r.subjectId))).toEqual(new Set([linked.id, sibling.id]));
    expect(pendingRows.map((r) => r.subjectId)).not.toContain(unrelated.id);

    // Visible from either row's perspective.
    expect(await pendingStudentDeletionRequest(ids, prisma)).not.toBeNull();

    const { cancelled } = await cancelStudentDeletionRequests(ids, prisma);
    expect(cancelled).toBe(2);
    expect(await pendingStudentDeletionRequest(ids, prisma)).toBeNull();
    const after = await prisma.accountDeletionRequest.findMany({
      where: { status: "cancelled" },
    });
    expect(after).toHaveLength(2);
  });

  it("identity export contains every row's snapshot, not just the linked one", async () => {
    const prisma = getTestPrisma();
    const { linked, sibling } = await seedIdentityPair();
    await prisma.package.create({
      data: {
        teacherId: TEACHER_B,
        studentId: sibling.id,
        classesTotal: 4,
        classesUsed: 1,
        pricePaidMinorUnits: 130_000,
        purchasedAt: new Date(),
        status: "active",
      },
    });

    const envelope = await buildStudentIdentityExport(
      prisma,
      await studentComplianceIds(linked, prisma),
    );
    expect(envelope).not.toBeNull();
    expect(envelope!.subjectId).toBe(linked.id);

    const data = envelope!.data as { identityRows: Array<{ id: string; packages: unknown[] }> };
    expect(data.identityRows).toHaveLength(2);
    const siblingRow = data.identityRows.find((r) => r.id === sibling.id);
    expect(siblingRow?.packages).toHaveLength(1);
  });

  it("a single-row identity keeps the original flat export shape", async () => {
    const prisma = getTestPrisma();
    const { unrelated } = await seedIdentityPair();

    const envelope = await buildStudentIdentityExport(prisma, [unrelated.id]);
    expect(envelope).not.toBeNull();
    // No identityRows wrapper — backwards-compatible with the pre-identity
    // export consumed by the web/mobile download buttons.
    expect((envelope!.data as { id: string }).id).toBe(unrelated.id);
  });
});
