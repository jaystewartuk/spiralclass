import { beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/students/teacher-profile.ts — the "My teachers" data layer. Asserts:
//   1. listStudentTeachers dedupes a teacher reached through multiple sibling
//      student rows, excludes archived pairings, and sorts by name;
//   2. getStudentTeacherProfile only resolves a teacher the student actually
//      has a TeacherStudent row with (any student id in their identity set),
//      and returns null otherwise — the access-control boundary;
//   3. countStudentTeachers agrees with listStudentTeachers about what counts,
//      since the profile page picks its BACK LINK from it — get it wrong for a
//      single-teacher student and "back" lands on a page that redirects
//      straight here again;
//   4. getNextClassWithTeacher spans the identity set and never reaches past
//      this teacher, this student, or the present moment.

const STUDENT_LINKED = "22222222-2222-4222-8222-222222222222";
const STUDENT_SIBLING = "22222222-2222-4222-8222-cccccccccccc";
const TEACHER_A = "11111111-1111-4111-8111-111111111111";
const TEACHER_B = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const TEACHER_ARCHIVED = "11111111-1111-4111-8111-dddddddddddd";
const TEACHER_STRANGER = "11111111-1111-4111-8111-eeeeeeeeeeee";

type TeacherRow = {
  id: string;
  name: string;
  email: string;
  phoneE164: string | null;
  publicWhatsappE164: string | null;
  timezone: string;
  teachingLanguage: string;
  targetLanguage: string | null;
  headline: string | null;
  bio: string | null;
  photoPath: string | null;
  updatedAt: Date;
  bookingSlug: string;
};

type PairingRow = { teacherId: string; studentId: string; archivedAt: Date | null };

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  status: string;
  scheduledStart: Date;
  package: { classDurationMin: number };
};

// Fixed "now" for the booking fixtures, so a scheduled class does not drift
// into the past as the suite ages.
const NOW = new Date("2026-09-02T12:00:00Z");
const hoursFromNow = (n: number) => new Date(NOW.getTime() + n * 60 * 60 * 1000);

const teachers: Record<string, TeacherRow> = {
  [TEACHER_A]: {
    id: TEACHER_A,
    name: "Beatriz",
    email: "beatriz@example.com",
    phoneE164: "+525512345678",
    publicWhatsappE164: "+525599998888",
    timezone: "America/Mexico_City",
    teachingLanguage: "es",
    targetLanguage: "en",
    headline: "Conversational English, one hour at a time",
    bio: "Bio A",
    photoPath: null,
    updatedAt: new Date(),
    bookingSlug: "beatriz",
  },
  [TEACHER_B]: {
    id: TEACHER_B,
    name: "Mira",
    email: "mira@example.com",
    phoneE164: null,
    publicWhatsappE164: null,
    timezone: "America/Bogota",
    teachingLanguage: "es",
    targetLanguage: "fr",
    headline: null,
    bio: null,
    photoPath: null,
    updatedAt: new Date(),
    bookingSlug: "mira",
  },
  [TEACHER_ARCHIVED]: {
    id: TEACHER_ARCHIVED,
    name: "Zoe",
    email: "zoe@example.com",
    phoneE164: null,
    publicWhatsappE164: null,
    timezone: "UTC",
    teachingLanguage: "en",
    targetLanguage: "en",
    headline: null,
    bio: null,
    photoPath: null,
    updatedAt: new Date(),
    bookingSlug: "zoe",
  },
  [TEACHER_STRANGER]: {
    id: TEACHER_STRANGER,
    name: "Stranger",
    email: "stranger@example.com",
    phoneE164: null,
    publicWhatsappE164: null,
    timezone: "UTC",
    teachingLanguage: "en",
    targetLanguage: "en",
    headline: null,
    bio: null,
    photoPath: null,
    updatedAt: new Date(),
    bookingSlug: "stranger",
  },
};

let pairings: PairingRow[] = [];
let bookings: BookingRow[] = [];

function freshState() {
  pairings = [
    // Same teacher reached via two sibling student rows — must dedupe.
    { teacherId: TEACHER_A, studentId: STUDENT_LINKED, archivedAt: null },
    { teacherId: TEACHER_A, studentId: STUDENT_SIBLING, archivedAt: null },
    { teacherId: TEACHER_B, studentId: STUDENT_LINKED, archivedAt: null },
    { teacherId: TEACHER_ARCHIVED, studentId: STUDENT_LINKED, archivedAt: new Date() },
  ];
  bookings = [
    // Already happened — the profile shows what is NEXT, not what was.
    {
      id: "past",
      teacherId: TEACHER_A,
      studentId: STUDENT_LINKED,
      status: "scheduled",
      scheduledStart: hoursFromNow(-24),
      package: { classDurationMin: 50 },
    },
    // Sooner, but cancelled.
    {
      id: "cancelled",
      teacherId: TEACHER_A,
      studentId: STUDENT_LINKED,
      status: "canceled_by_student",
      scheduledStart: hoursFromNow(1),
      package: { classDurationMin: 50 },
    },
    // Booked under the SIBLING student row — same person, so it counts.
    {
      id: "sibling-next",
      teacherId: TEACHER_A,
      studentId: STUDENT_SIBLING,
      status: "scheduled",
      scheduledStart: hoursFromNow(6),
      package: { classDurationMin: 25 },
    },
    {
      id: "later",
      teacherId: TEACHER_A,
      studentId: STUDENT_LINKED,
      status: "scheduled",
      scheduledStart: hoursFromNow(48),
      package: { classDurationMin: 50 },
    },
    // Another teacher's class, sooner than any of the above.
    {
      id: "other-teacher",
      teacherId: TEACHER_B,
      studentId: STUDENT_LINKED,
      status: "scheduled",
      scheduledStart: hoursFromNow(2),
      package: { classDurationMin: 50 },
    },
  ];
}

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: async () => [STUDENT_LINKED, STUDENT_SIBLING],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findMany: async ({ where, select, distinct }: any) => {
        const matched = pairings.filter(
          (p) =>
            where.studentId.in.includes(p.studentId) &&
            (where.archivedAt === undefined || p.archivedAt === where.archivedAt),
        );
        // countStudentTeachers selects `teacherId` and leans on Prisma's own
        // DISTINCT rather than deduping in JS, so the stub has to honour it or
        // the test would pass on a query the database would answer differently.
        if (distinct?.includes("teacherId")) {
          const seen = new Set<string>();
          return matched
            .filter((p) => !seen.has(p.teacherId) && seen.add(p.teacherId))
            .map((p) => ({ teacherId: p.teacherId }));
        }
        if (select?.teacherId) return matched.map((p) => ({ teacherId: p.teacherId }));
        return matched.map((p) => ({ teacher: teachers[p.teacherId] }));
      },
      findFirst: async ({ where }: any) => {
        const match = pairings.find(
          (p) => p.teacherId === where.teacherId && where.studentId.in.includes(p.studentId),
        );
        return match ? { teacher: teachers[match.teacherId] } : null;
      },
    },
    booking: {
      findFirst: async ({ where }: any) =>
        bookings
          .filter(
            (b) =>
              b.teacherId === where.teacherId &&
              where.studentId.in.includes(b.studentId) &&
              b.status === where.status &&
              b.scheduledStart > where.scheduledStart.gt,
          )
          .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())[0] ?? null,
    },
  },
}));

const {
  countStudentTeachers,
  getNextClassWithTeacher,
  getStudentTeacherProfile,
  listStudentTeachers,
} = await import("@/lib/students/teacher-profile");

const STUDENT = { id: STUDENT_LINKED, email: "s@example.com" };

beforeEach(() => {
  freshState();
});

describe("listStudentTeachers", () => {
  it("dedupes a teacher reached through multiple sibling rows and sorts by name", async () => {
    const result = await listStudentTeachers(STUDENT);
    expect(result.map((t) => t.id)).toEqual([TEACHER_A, TEACHER_B]); // "Beatriz" < "Mira"
  });

  it("excludes archived pairings", async () => {
    const result = await listStudentTeachers(STUDENT);
    expect(result.map((t) => t.id)).not.toContain(TEACHER_ARCHIVED);
  });
});

describe("getStudentTeacherProfile", () => {
  it("resolves a teacher the student has any pairing with", async () => {
    const profile = await getStudentTeacherProfile(STUDENT, TEACHER_A);
    expect(profile?.name).toBe("Beatriz");
    expect(profile?.email).toBe("beatriz@example.com");
  });

  it("still resolves an archived pairing (only the list hides it, not direct access)", async () => {
    const profile = await getStudentTeacherProfile(STUDENT, TEACHER_ARCHIVED);
    expect(profile?.name).toBe("Zoe");
  });

  it("returns null for a teacher the student has no relationship with", async () => {
    const profile = await getStudentTeacherProfile(STUDENT, TEACHER_STRANGER);
    expect(profile).toBeNull();
  });
});

describe("getStudentTeacherProfile — the fields it is allowed to expose", () => {
  it("carries the public booking-page fields the profile renders", async () => {
    const profile = await getStudentTeacherProfile(STUDENT, TEACHER_A);
    // Both are already on /b/<slug> for anyone at all; a student who studies
    // with her is not a narrower audience than the open internet.
    expect(profile?.headline).toBe("Conversational English, one hour at a time");
    expect(profile?.publicWhatsappE164).toBe("+525599998888");
  });

  it("leaves them null when the teacher never filled them in", async () => {
    const profile = await getStudentTeacherProfile(STUDENT, TEACHER_B);
    expect(profile?.headline).toBeNull();
    expect(profile?.publicWhatsappE164).toBeNull();
  });
});

describe("countStudentTeachers", () => {
  it("agrees with listStudentTeachers, deduping siblings and excluding archived", async () => {
    // The page picks its back link from this number, so the two must not be
    // able to disagree: at 1 it links to the classes list, because
    // /my-classes/teachers redirects a single-teacher student straight back.
    const listed = await listStudentTeachers(STUDENT);
    expect(await countStudentTeachers(STUDENT)).toBe(listed.length);
    expect(listed.length).toBe(2);
  });

  it("counts one for a student with a single teacher", async () => {
    pairings = [{ teacherId: TEACHER_A, studentId: STUDENT_LINKED, archivedAt: null }];
    expect(await countStudentTeachers(STUDENT)).toBe(1);
  });

  it("counts zero when every pairing is archived", async () => {
    pairings = [{ teacherId: TEACHER_A, studentId: STUDENT_LINKED, archivedAt: new Date() }];
    expect(await countStudentTeachers(STUDENT)).toBe(0);
  });
});

describe("getNextClassWithTeacher", () => {
  it("returns the soonest future class, including one booked under a sibling row", async () => {
    const next = await getNextClassWithTeacher(STUDENT, TEACHER_A, NOW);
    expect(next?.id).toBe("sibling-next");
    expect(next?.durationMin).toBe(25);
  });

  it("ignores classes with another teacher", async () => {
    // TEACHER_B's class is two hours away — sooner than anything with
    // TEACHER_A — and must not surface on TEACHER_A's profile.
    const next = await getNextClassWithTeacher(STUDENT, TEACHER_A, NOW);
    expect(next?.id).not.toBe("other-teacher");
    expect((await getNextClassWithTeacher(STUDENT, TEACHER_B, NOW))?.id).toBe("other-teacher");
  });

  it("ignores past and cancelled classes", async () => {
    bookings = bookings.filter((b) => b.id === "past" || b.id === "cancelled");
    expect(await getNextClassWithTeacher(STUDENT, TEACHER_A, NOW)).toBeNull();
  });

  it("returns null when there is nothing on the calendar", async () => {
    bookings = [];
    expect(await getNextClassWithTeacher(STUDENT, TEACHER_A, NOW)).toBeNull();
  });
});
