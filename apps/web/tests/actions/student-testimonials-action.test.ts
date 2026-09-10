import { beforeEach, describe, expect, it, vi } from "vitest";
import { TESTIMONIAL_BODY_MAX } from "@/lib/testimonials/limits";

// The student's own testimonial actions.
//
// The property under test throughout is that the row written is the one the
// PLATFORM resolved from the session, never one the form named. A form field
// the caller controls deciding whose testimonial this is would make the write
// path a nicer-looking version of the problem the verified badge exists to fix.

const state = {
  eligibility: {
    studentId: "s1" as string | null,
    completedClasses: 3,
    eligible: true,
  },
  studentName: "Mira" as string | null,
};

const testimonialEligibility = vi.fn(async () => state.eligibility);
vi.mock("@/lib/testimonials/eligibility", () => ({
  testimonialEligibility: (...a: unknown[]) => testimonialEligibility(...(a as [])),
}));

const upsertStudentTestimonial = vi.fn(async () => ({ id: "ts1" }));
const deleteStudentTestimonial = vi.fn(async () => true);
vi.mock("@/lib/testimonials/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/testimonials/store")>();
  return {
    // The real Zod schema — the point is that the action rejects what it rejects.
    studentTestimonialInputSchema: actual.studentTestimonialInputSchema,
    upsertStudentTestimonial: (...a: unknown[]) => upsertStudentTestimonial(...(a as [])),
    deleteStudentTestimonial: (...a: unknown[]) => deleteStudentTestimonial(...(a as [])),
  };
});

const findUnique = vi.fn(async () => ({ name: state.studentName }));
const teacherFindUnique = vi.fn(async () => ({ bookingSlug: "mira" }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    student: { findUnique: (...a: unknown[]) => findUnique(...(a as [])) },
    teacher: { findUnique: (...a: unknown[]) => teacherFindUnique(...(a as [])) },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireStudent: vi.fn(async () => ({ id: "s1", email: "mira@example.com" })),
}));

vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { saveStudentTestimonial, removeStudentTestimonial } =
  await import("@/app/actions/student-testimonials");

const TEACHER = "11111111-1111-1111-1111-111111111111";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.eligibility = { studentId: "s1", completedClasses: 3, eligible: true };
  state.studentName = "Mira";
});

describe("saveStudentTestimonial", () => {
  it("writes the resolved student id and the roster name, not anything from the form", async () => {
    const res = await saveStudentTestimonial(
      undefined,
      form({
        teacherId: TEACHER,
        body: "Six months in and I can hold a conversation.",
        // Both ignored: the action never reads them.
        studentId: "somebody-else",
        authorName: "A Name She Picked",
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(upsertStudentTestimonial).toHaveBeenCalledWith(TEACHER, "s1", "Mira", {
      body: "Six months in and I can hold a conversation.",
    });
  });

  it("refuses when the student has no completed class with this teacher", async () => {
    state.eligibility = { studentId: "s1", completedClasses: 0, eligible: false };
    const res = await saveStudentTestimonial(
      undefined,
      form({ teacherId: TEACHER, body: "Great." }),
    );
    expect(res?.error).toBeTruthy();
    expect(upsertStudentTestimonial).not.toHaveBeenCalled();
  });

  it("refuses when there is no pairing with this teacher at all", async () => {
    state.eligibility = { studentId: null, completedClasses: 0, eligible: false };
    const res = await saveStudentTestimonial(
      undefined,
      form({ teacherId: TEACHER, body: "Great." }),
    );
    expect(res?.error).toBeTruthy();
    expect(upsertStudentTestimonial).not.toHaveBeenCalled();
  });

  it("gives the same message either way, so a signed-in stranger cannot probe pairings", async () => {
    state.eligibility = { studentId: "s1", completedClasses: 0, eligible: false };
    const notYet = await saveStudentTestimonial(
      undefined,
      form({ teacherId: TEACHER, body: "Great." }),
    );
    state.eligibility = { studentId: null, completedClasses: 0, eligible: false };
    const notMine = await saveStudentTestimonial(
      undefined,
      form({ teacherId: TEACHER, body: "Great." }),
    );
    expect(notYet?.error).toBe(notMine?.error);
  });

  it("rejects an empty or over-long body without writing", async () => {
    expect(
      (await saveStudentTestimonial(undefined, form({ teacherId: TEACHER, body: "" })))?.error,
    ).toBeTruthy();
    expect(
      (
        await saveStudentTestimonial(
          undefined,
          form({ teacherId: TEACHER, body: "x".repeat(TESTIMONIAL_BODY_MAX + 1) }),
        )
      )?.error,
    ).toBeTruthy();
    expect(upsertStudentTestimonial).not.toHaveBeenCalled();
  });

  it("refuses a nameless roster row rather than publishing an anonymous quote", async () => {
    state.studentName = "   ";
    const res = await saveStudentTestimonial(
      undefined,
      form({ teacherId: TEACHER, body: "Great classes." }),
    );
    expect(res?.error).toBeTruthy();
    expect(upsertStudentTestimonial).not.toHaveBeenCalled();
  });

  it("revalidates only the page the student wrote it from (D-174)", async () => {
    await saveStudentTestimonial(undefined, form({ teacherId: TEACHER, body: "Great classes." }));
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual([`/my-classes/teachers/${TEACHER}`]);
  });
});

describe("removeStudentTestimonial", () => {
  it("withdraws the student's own row, scoped by the resolved id", async () => {
    const res = await removeStudentTestimonial(undefined, form({ teacherId: TEACHER }));
    expect(res).toEqual({ ok: true });
    expect(deleteStudentTestimonial).toHaveBeenCalledWith(TEACHER, "s1");
  });

  it("still works for a student who is no longer eligible", async () => {
    // Consent to being quoted in public has to be revocable on the same terms
    // it was given — an archived pairing must not strand a quote on her page.
    state.eligibility = { studentId: "s1", completedClasses: 0, eligible: false };
    const res = await removeStudentTestimonial(undefined, form({ teacherId: TEACHER }));
    expect(res).toEqual({ ok: true });
    expect(deleteStudentTestimonial).toHaveBeenCalledWith(TEACHER, "s1");
  });

  it("rejects a malformed teacher id without writing", async () => {
    const res = await removeStudentTestimonial(undefined, form({ teacherId: "not-a-uuid" }));
    expect(res?.error).toBeTruthy();
    expect(deleteStudentTestimonial).not.toHaveBeenCalled();
  });
});
