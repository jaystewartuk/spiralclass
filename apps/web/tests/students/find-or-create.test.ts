import { describe, expect, it, vi } from "vitest";
import {
  findOrCreateRosterStudent,
  TeacherEmailConflictError,
} from "@/lib/students/find-or-create";

// Advisory-locked find-or-create (unit-level; the integration suite exercises
// the real advisory lock). Pin: existing rows are updated (with the phone
// field applied only when provided), and a first purchase creates the row
// plus the roster link. Also pins D-38: a NEW row is never created for an
// email that already belongs to a Teacher account.

function fakeDb(
  existing: { id: string } | null,
  teacherConflict: { id: string } | null = null,
  // The teacher's "share progress with my students" policy, which a new roster
  // link inherits. Defaults off, matching the column default.
  shareProgressByDefault = false,
) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const holdClears: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    student: {
      findFirst: vi.fn(async () => existing),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updated.push({ id: where.id, data });
          return { id: where.id, ...data };
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "new", ...data };
      }),
    },
    teacher: {
      findFirst: vi.fn(async () => teacherConflict),
      findUnique: vi.fn(async () => ({ shareProgressByDefault })),
    },
    teacherStudent: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          holdClears.push({ where, data });
          return { count: 1 };
        },
      ),
    },
  };
  const db = { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) };
  return { db: db as never, created, updated, holdClears, tx };
}

const base = {
  teacherId: "t1",
  email: "mira@x.com",
  name: "Mira",
  phoneE164: null as string | null,
};

describe("findOrCreateRosterStudent", () => {
  it("takes the advisory lock before reading", async () => {
    const { db, tx } = fakeDb({ id: "s1" });
    await findOrCreateRosterStudent(base, db);
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it("updates an existing roster row's name (no phone field when absent)", async () => {
    const { db, updated } = fakeDb({ id: "s1" });
    await findOrCreateRosterStudent({ ...base, name: "Alicia Moreno" }, db);
    expect(updated).toHaveLength(1);
    expect(updated[0].data).toEqual({ name: "Alicia Moreno" });
  });

  it("updates the phone number on an existing row when provided", async () => {
    const { db, updated } = fakeDb({ id: "s1" });
    await findOrCreateRosterStudent({ ...base, phoneE164: "+5215512345678" }, db);
    expect(updated[0].data).toMatchObject({
      phoneE164: "+5215512345678",
    });
  });

  it("lifts a silent-onboarding hold when an existing student self-purchases", async () => {
    const { db, holdClears } = fakeDb({ id: "s1" });
    await findOrCreateRosterStudent(base, db);
    expect(holdClears).toHaveLength(1);
    expect(holdClears[0]).toMatchObject({
      where: { teacherId: "t1", studentId: "s1", onboardingHoldAt: { not: null } },
      data: { onboardingHoldAt: null },
    });
  });

  it("creates the row + roster link on a first purchase", async () => {
    const { db, created } = fakeDb(null);
    await findOrCreateRosterStudent(base, db);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      email: "mira@x.com",
      name: "Mira",
      teacherStudents: { create: { teacherId: "t1", shareProgress: false } },
    });
  });

  it("inherits the teacher's progress-sharing policy on the new roster link", async () => {
    // The booking page promises the vocabulary review whenever this is on, so
    // a student created after that promise was made has to arrive already
    // sharing — otherwise the promise is true for the roster she had when she
    // flipped the switch and false for everyone who bought afterwards.
    const { db, created } = fakeDb(null, null, true);
    await findOrCreateRosterStudent(base, db);
    expect(created[0]).toMatchObject({
      teacherStudents: { create: { teacherId: "t1", shareProgress: true } },
    });
  });

  it("leaves locale unset so the column default applies, not a hardcoded es-MX", async () => {
    // The checkout funnel a new student just came through is English on
    // purpose; stamping the row es-MX here sent that student Spanish class
    // reminders forever after, contradicting the surface that created her.
    const { db, created } = fakeDb(null);
    await findOrCreateRosterStudent(base, db);
    expect(created[0]).not.toHaveProperty("locale");
  });

  it("stamps the trimmed default notification prefs on a new row", async () => {
    const { db, created } = fakeDb(null);
    await findOrCreateRosterStudent(base, db);
    expect(created[0].notificationPrefs).toEqual({
      class_reminders: true,
      booking_updates: true,
      messages: true,
      class_materials: false,
      expiry_reminders: false,
    });
  });

  it("refuses to create a new roster row when the email belongs to a Teacher (D-38)", async () => {
    const { db, created } = fakeDb(null, { id: "teacher-1" });
    await expect(findOrCreateRosterStudent(base, db)).rejects.toThrow(TeacherEmailConflictError);
    expect(created).toHaveLength(0);
  });

  it("does not check Teacher.email when an existing roster row is found", async () => {
    const { db, tx } = fakeDb({ id: "s1" });
    await findOrCreateRosterStudent(base, db);
    expect(tx.teacher.findFirst).not.toHaveBeenCalled();
  });
});
