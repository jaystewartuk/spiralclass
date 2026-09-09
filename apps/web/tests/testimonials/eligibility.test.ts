import { beforeEach, describe, expect, it, vi } from "vitest";

// Who may write a verified testimonial, and what the badge is allowed to say.
// The two answers come from the same place on purpose — the write path and the
// public page must never disagree about a student's standing — so both are
// covered here together.

const teacherStudentFindFirst = vi.fn();
const bookingCount = vi.fn();
const bookingGroupBy = vi.fn();
const studentIdentityIds = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: { findFirst: (...a: unknown[]) => teacherStudentFindFirst(...a) },
    booking: {
      count: (...a: unknown[]) => bookingCount(...a),
      groupBy: (...a: unknown[]) => bookingGroupBy(...a),
    },
  },
}));

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: (...a: unknown[]) => studentIdentityIds(...a),
}));

import { completedClassCounts, testimonialEligibility } from "@/lib/testimonials/eligibility";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const LINKED = "22222222-2222-4222-8222-222222222222";
const SIBLING = "33333333-3333-4333-8333-333333333333";

const STUDENT = { id: LINKED, email: "mira@example.com" };

beforeEach(() => {
  teacherStudentFindFirst.mockReset();
  bookingCount.mockReset();
  bookingGroupBy.mockReset();
  studentIdentityIds.mockReset();
  studentIdentityIds.mockResolvedValue([LINKED, SIBLING]);
});

describe("testimonialEligibility", () => {
  it("resolves the Student row paired with THIS teacher, across the identity set", async () => {
    // A person studying with two teachers has two rows and only one of them is
    // this teacher's; storing the wrong one would attach the quote to the wrong
    // pairing and make the class count meaningless.
    teacherStudentFindFirst.mockResolvedValue({ studentId: SIBLING });
    bookingCount.mockResolvedValue(4);

    const result = await testimonialEligibility(STUDENT, TEACHER);

    expect(teacherStudentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: TEACHER, studentId: { in: [LINKED, SIBLING] } },
      }),
    );
    expect(result).toEqual({ studentId: SIBLING, completedClasses: 4, eligible: true });
  });

  it("counts only completed classes", async () => {
    teacherStudentFindFirst.mockResolvedValue({ studentId: LINKED });
    bookingCount.mockResolvedValue(1);

    await testimonialEligibility(STUDENT, TEACHER);

    // Not scheduled, not cancelled, and deliberately not no_show: the class was
    // billed but the student was never taught, so it cannot count toward an
    // opinion about the teaching.
    expect(bookingCount).toHaveBeenCalledWith({
      where: { teacherId: TEACHER, studentId: LINKED, status: "completed" },
    });
  });

  it("is not eligible with no completed classes yet", async () => {
    teacherStudentFindFirst.mockResolvedValue({ studentId: LINKED });
    bookingCount.mockResolvedValue(0);
    const result = await testimonialEligibility(STUDENT, TEACHER);
    expect(result).toEqual({ studentId: LINKED, completedClasses: 0, eligible: false });
  });

  it("is eligible after exactly one — the floor is deliberately low", async () => {
    teacherStudentFindFirst.mockResolvedValue({ studentId: LINKED });
    bookingCount.mockResolvedValue(1);
    expect((await testimonialEligibility(STUDENT, TEACHER)).eligible).toBe(true);
  });

  it("returns no student id at all when there is no pairing with this teacher", async () => {
    teacherStudentFindFirst.mockResolvedValue(null);
    const result = await testimonialEligibility(STUDENT, TEACHER);
    expect(result).toEqual({ studentId: null, completedClasses: 0, eligible: false });
    // No point counting bookings for a pairing that does not exist.
    expect(bookingCount).not.toHaveBeenCalled();
  });
});

describe("completedClassCounts", () => {
  it("returns one grouped query's worth of counts, keyed by student", async () => {
    bookingGroupBy.mockResolvedValue([
      { studentId: LINKED, _count: { _all: 12 } },
      { studentId: SIBLING, _count: { _all: 3 } },
    ]);

    const counts = await completedClassCounts(TEACHER, [LINKED, SIBLING]);

    expect(counts.get(LINKED)).toBe(12);
    expect(counts.get(SIBLING)).toBe(3);
    expect(bookingGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["studentId"],
        where: {
          teacherId: TEACHER,
          studentId: { in: [LINKED, SIBLING] },
          status: "completed",
        },
      }),
    );
  });

  it("does not query at all for a page with no verified testimonials", async () => {
    const counts = await completedClassCounts(TEACHER, []);
    expect(counts.size).toBe(0);
    expect(bookingGroupBy).not.toHaveBeenCalled();
  });

  it("omits a student with no completed classes rather than inventing a zero", async () => {
    // The caller renders the badge without a count in that case; a "0 classes"
    // line beside "Verified student" would read as a contradiction.
    bookingGroupBy.mockResolvedValue([]);
    const counts = await completedClassCounts(TEACHER, [LINKED]);
    expect(counts.has(LINKED)).toBe(false);
  });
});
