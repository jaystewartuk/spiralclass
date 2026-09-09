import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { lessonNoteStudentVisible } from "@/lib/lesson-notes/visibility";

// Real-DB proof of the lesson-notes invariants the in-memory action unit tests
// can't reach: the actual `NoteAudience` enum + FK cascade, cross-teacher
// isolation through the booking relation, and the exact query the student page
// runs (audience = "student", ordered by position) combined with the class
// window gate (D-15). Seeds two teachers so "scoped to my own bookings" is
// proven against a populated table, not an empty one.

const TEACHER_A = "11111111-1111-4111-8111-111111111111";
const TEACHER_B = "22222222-2222-4222-8222-222222222222";

const START = new Date("2026-06-23T15:00:00Z");
const END = new Date("2026-06-23T15:50:00Z");

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

// A teacher with one student, one active package, and one scheduled booking.
// Returns the booking id the notes hang off.
async function seedTeacherWithBooking(opts: { teacherId: string; slug: string }): Promise<string> {
  const prisma = getTestPrisma();
  await ensureAuthUser(opts.teacherId, `${opts.slug}@e2e.test`);
  await prisma.teacher.create({
    data: {
      id: opts.teacherId,
      email: `${opts.slug}@e2e.test`,
      name: `${opts.slug} teacher`,
      timezone: "America/Mexico_City",
      bookingSlug: opts.slug,
    },
  });
  const student = await prisma.student.create({
    data: { email: `${opts.slug}-student@e2e.test`, name: "Student" },
    select: { id: true },
  });
  await prisma.teacherStudent.create({
    data: { teacherId: opts.teacherId, studentId: student.id },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId: opts.teacherId,
      studentId: student.id,
      classesTotal: 10,
      classesUsed: 0,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date("2026-06-01T00:00:00Z"),
      expiresAt: null,
      status: "active",
    },
    select: { id: true },
  });
  const booking = await prisma.booking.create({
    data: {
      packageId: pkg.id,
      teacherId: opts.teacherId,
      studentId: student.id,
      scheduledStart: START,
      scheduledEnd: END,
      status: "scheduled",
    },
    select: { id: true },
  });
  return booking.id;
}

// Mirrors the exact read the student booking-detail page runs
// (apps/web/src/app/(student)/my-classes/[bookingId]/page.tsx): only
// student-audience notes are ever selected for a student.
function readStudentNotes(bookingId: string) {
  return getTestPrisma().lessonNote.findMany({
    where: { bookingId, audience: "student" },
    select: { id: true, body: true },
    orderBy: { position: "asc" },
  });
}

describeIntegration("lesson notes (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("never surfaces a teacher cue on the student read path, only student notes in order", async () => {
    const prisma = getTestPrisma();
    const bookingId = await seedTeacherWithBooking({ teacherId: TEACHER_A, slug: "alpha" });

    await prisma.lessonNote.createMany({
      data: [
        {
          bookingId,
          teacherId: TEACHER_A,
          audience: "teacher",
          body: "watch the clock",
          position: 0,
        },
        { bookingId, teacherId: TEACHER_A, audience: "student", body: "second", position: 1 },
        { bookingId, teacherId: TEACHER_A, audience: "student", body: "first", position: 0 },
      ],
    });

    const visible = await readStudentNotes(bookingId);
    // teacher cue excluded; student notes returned in position order
    expect(visible.map((n) => n.body)).toEqual(["first", "second"]);
  });

  it("the student read for one booking can't see another teacher's notes", async () => {
    const prisma = getTestPrisma();
    const bookingA = await seedTeacherWithBooking({ teacherId: TEACHER_A, slug: "alpha" });
    const bookingB = await seedTeacherWithBooking({ teacherId: TEACHER_B, slug: "beta" });

    await prisma.lessonNote.createMany({
      data: [
        {
          bookingId: bookingA,
          teacherId: TEACHER_A,
          audience: "student",
          body: "A note",
          position: 0,
        },
        {
          bookingId: bookingB,
          teacherId: TEACHER_B,
          audience: "student",
          body: "B note",
          position: 0,
        },
      ],
    });

    const aNotes = await readStudentNotes(bookingA);
    expect(aNotes.map((n) => n.body)).toEqual(["A note"]);
    const bNotes = await readStudentNotes(bookingB);
    expect(bNotes.map((n) => n.body)).toEqual(["B note"]);
  });

  it("the class-window gate hides student notes outside the window and shows them inside (D-15)", async () => {
    const prisma = getTestPrisma();
    const bookingId = await seedTeacherWithBooking({ teacherId: TEACHER_A, slug: "alpha" });
    await prisma.lessonNote.create({
      data: {
        bookingId,
        teacherId: TEACHER_A,
        audience: "student",
        body: "join on time",
        position: 0,
      },
    });

    const rows = await readStudentNotes(bookingId);
    expect(rows).toHaveLength(1);

    // The page only renders rows when the window is open; replicate that gate.
    const wayBefore = new Date(START.getTime() - 2 * 60 * 60_000);
    const during = new Date(START.getTime() + 10 * 60_000);
    expect(lessonNoteStudentVisible(START, END, wayBefore)).toBe(false);
    expect(lessonNoteStudentVisible(START, END, during)).toBe(true);
  });

  it("cascades note deletion when the parent booking is removed", async () => {
    const prisma = getTestPrisma();
    const bookingId = await seedTeacherWithBooking({ teacherId: TEACHER_A, slug: "alpha" });
    await prisma.lessonNote.create({
      data: { bookingId, teacherId: TEACHER_A, audience: "teacher", body: "cue", position: 0 },
    });

    await prisma.booking.delete({ where: { id: bookingId } });
    const orphaned = await prisma.lessonNote.count({ where: { bookingId } });
    expect(orphaned).toBe(0);
  });

  it("stores one summary per booking and cascades it on booking delete", async () => {
    const prisma = getTestPrisma();
    const bookingId = await seedTeacherWithBooking({ teacherId: TEACHER_A, slug: "alpha" });

    await prisma.lessonSummary.create({
      data: {
        bookingId,
        teacherId: TEACHER_A,
        body: "Covered past tense.",
        model: "claude-haiku-4-5",
      },
    });
    // booking_id is unique — a second summary for the same booking is rejected.
    await expect(
      prisma.lessonSummary.create({
        data: { bookingId, teacherId: TEACHER_A, body: "dup", model: "claude-haiku-4-5" },
      }),
    ).rejects.toThrow();

    await prisma.booking.delete({ where: { id: bookingId } });
    expect(await prisma.lessonSummary.count({ where: { bookingId } })).toBe(0);
  });
});
