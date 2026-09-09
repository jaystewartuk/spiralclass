import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The acquisition profile is four fields, and everything else is inferred from
// the account she already maintains. These tests pin BOTH halves: the schema
// that bounds what she can type, and the inference that decides what the
// generator is allowed to say about her.

const teacherFindUnique = vi.fn();
const profileFindUnique = vi.fn();
const profileUpsert = vi.fn();
const testimonialFindMany = vi.fn();
const templateFindMany = vi.fn();
const ruleFindMany = vi.fn();
const linkCount = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: teacherFindUnique },
    teacherMarketingProfile: { findUnique: profileFindUnique, upsert: profileUpsert },
    testimonial: { findMany: testimonialFindMany },
    packageTemplate: { findMany: templateFindMany },
    availabilityRule: { findMany: ruleFindMany },
    teacherStudent: { count: linkCount },
  },
}));

const {
  DEFAULT_MARKETING_PROFILE,
  buildTeacherContext,
  getMarketingProfile,
  marketingProfileInputSchema,
  saveMarketingProfile,
} = await import("@/lib/marketing/profile");

beforeEach(() => {
  vi.clearAllMocks();
  profileFindUnique.mockResolvedValue(null);
  testimonialFindMany.mockResolvedValue([]);
  templateFindMany.mockResolvedValue([]);
  ruleFindMany.mockResolvedValue([]);
  linkCount.mockResolvedValue(0);
});

describe("marketingProfileInputSchema", () => {
  it("defaults every list and the time budget, so the form works empty", () => {
    const parsed = marketingProfileInputSchema.parse({});
    expect(parsed).toMatchObject({
      audiences: [],
      learnerLocations: [],
      levels: [],
      weeklyMinutes: 60,
      goalNewStudentsPerMonth: 2,
    });
  });

  it("bounds the lists and the free text", () => {
    expect(marketingProfileInputSchema.safeParse({ audiences: Array(7).fill("x") }).success).toBe(
      false,
    );
    expect(marketingProfileInputSchema.safeParse({ audiences: ["x".repeat(41)] }).success).toBe(
      false,
    );
    expect(marketingProfileInputSchema.safeParse({ differentiator: "y".repeat(241) }).success).toBe(
      false,
    );
  });

  it("keeps the time budget inside a range a teacher would actually honour", () => {
    expect(marketingProfileInputSchema.safeParse({ weeklyMinutes: 10 }).success).toBe(false);
    expect(marketingProfileInputSchema.safeParse({ weeklyMinutes: 400 }).success).toBe(false);
    expect(marketingProfileInputSchema.parse({ weeklyMinutes: "90" }).weeklyMinutes).toBe(90);
  });

  it("treats an empty differentiator as absent rather than as an empty string", () => {
    expect(
      marketingProfileInputSchema.parse({ differentiator: "" }).differentiator,
    ).toBeUndefined();
  });
});

describe("getMarketingProfile", () => {
  it("returns the defaults when she has never opened the screen", async () => {
    expect(await getMarketingProfile("t1")).toEqual(DEFAULT_MARKETING_PROFILE);
  });

  it("returns her saved row when one exists", async () => {
    profileFindUnique.mockResolvedValue({
      audiences: ["expats"],
      learnerLocations: ["Oaxaca"],
      levels: ["beginner"],
      differentiator: "adults only",
      weeklyMinutes: 90,
      goalNewStudentsPerMonth: 4,
    });
    expect(await getMarketingProfile("t1")).toMatchObject({
      audiences: ["expats"],
      weeklyMinutes: 90,
      goalNewStudentsPerMonth: 4,
    });
  });
});

describe("saveMarketingProfile", () => {
  it("upserts, so the first save and every later one take the same path", async () => {
    await saveMarketingProfile("t1", {
      audiences: ["expats"],
      learnerLocations: [],
      levels: [],
      differentiator: undefined,
      weeklyMinutes: 45,
      goalNewStudentsPerMonth: 3,
    });
    const call = profileUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ teacherId: "t1" });
    expect(call.create).toMatchObject({ teacherId: "t1", weeklyMinutes: 45 });
    expect(call.update.differentiator).toBeNull();
  });
});

describe("buildTeacherContext", () => {
  const TEACHER = {
    id: "t1",
    name: "Alicia Moreno",
    bookingSlug: "mira",
    headline: "Conversational Spanish",
    bio: "Ten years in Oaxaca.",
    photoPath: "t1/photo.jpg",
    locale: "es-MX",
    country: "MX",
    targetLanguage: "es",
    teachingLanguage: "es",
  };

  it("returns null for a teacher that does not exist", async () => {
    teacherFindUnique.mockResolvedValue(null);
    expect(await buildTeacherContext("nope")).toBeNull();
  });

  it("infers the subject from the language she teaches (D-72)", async () => {
    teacherFindUnique.mockResolvedValue({ ...TEACHER, targetLanguage: "fr" });
    const ctx = await buildTeacherContext("t1");
    expect(ctx?.subject).toBe("French");
  });

  it("falls back to Spanish when no target language is set", async () => {
    teacherFindUnique.mockResolvedValue({ ...TEACHER, targetLanguage: null });
    expect((await buildTeacherContext("t1"))?.subject).toBe("Spanish");
  });

  it("derives capabilities from real rows, which is what gates content honesty", async () => {
    teacherFindUnique.mockResolvedValue(TEACHER);
    testimonialFindMany.mockResolvedValue([
      { authorName: "Sam", authorNote: null, body: "Great." },
    ]);
    templateFindMany.mockResolvedValue([
      { name: "Starter", classes: 4, priceMinorUnits: 200000, currency: "MXN" },
    ]);
    ruleFindMany.mockResolvedValue([{ weekday: 2 }, { weekday: 4 }]);
    linkCount.mockResolvedValue(7);

    const ctx = await buildTeacherContext("t1");
    expect(ctx?.capabilities).toEqual({
      hasTestimonial: true,
      hasPackage: true,
      hasStudents: true,
      hasAvailability: true,
      hasPhoto: true,
    });
    expect(ctx?.availableWeekdays).toEqual(["Tuesday", "Thursday"]);
    expect(ctx?.activeStudentCount).toBe(7);
  });

  it("reports every capability false for a brand-new teacher", async () => {
    teacherFindUnique.mockResolvedValue({ ...TEACHER, photoPath: null });
    const ctx = await buildTeacherContext("t1");
    expect(ctx?.capabilities).toEqual({
      hasTestimonial: false,
      hasPackage: false,
      hasStudents: false,
      hasAvailability: false,
      hasPhoto: false,
    });
  });

  it("counts only non-archived students", async () => {
    teacherFindUnique.mockResolvedValue(TEACHER);
    await buildTeacherContext("t1");
    expect(linkCount.mock.calls[0][0]).toMatchObject({
      where: { teacherId: "t1", archivedAt: null },
    });
  });

  it("reads only PUBLISHED testimonials — a hidden one must never be quoted", async () => {
    teacherFindUnique.mockResolvedValue(TEACHER);
    await buildTeacherContext("t1");
    expect(testimonialFindMany.mock.calls[0][0]).toMatchObject({
      where: { teacherId: "t1", published: true },
    });
  });
});
