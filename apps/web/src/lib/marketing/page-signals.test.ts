import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The counts must use the SAME filters the public page renders with. A check
// that disagrees with the page it checks is worse than no check — it would
// tell a teacher she has testimonials up while every one of them is
// unpublished — so the filters are asserted, not just the totals.
const packageTemplateCount = vi.fn();
const testimonialCount = vi.fn();
const introVideoStorageConfigured = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    packageTemplate: { count: (...a: unknown[]) => packageTemplateCount(...a) },
    testimonial: { count: (...a: unknown[]) => testimonialCount(...a) },
  },
}));
vi.mock("@/lib/storage/teacher-video", () => ({
  introVideoStorageConfigured: () => introVideoStorageConfigured(),
}));

const { pageSignalsFor } = await import("./page-signals");

const TEACHER = {
  id: "teacher-1",
  photoPath: "photos/mira.jpg",
  headline: "Spanish for expats",
  bio: "A long enough introduction.",
  introVideoPath: "videos/mira.mp4",
};

beforeEach(() => {
  vi.clearAllMocks();
  packageTemplateCount.mockResolvedValue(3);
  testimonialCount.mockResolvedValue(2);
  introVideoStorageConfigured.mockReturnValue(true);
});

describe("pageSignalsFor", () => {
  it("counts only what a visitor would actually see", async () => {
    await pageSignalsFor(TEACHER);
    expect(packageTemplateCount).toHaveBeenCalledWith({
      where: { teacherId: "teacher-1", archived: false },
    });
    expect(testimonialCount).toHaveBeenCalledWith({
      where: { teacherId: "teacher-1", published: true },
    });
  });

  it("maps the teacher's own columns onto the signals", async () => {
    expect(await pageSignalsFor(TEACHER)).toEqual({
      hasPhoto: true,
      headline: "Spanish for expats",
      bio: "A long enough introduction.",
      packageCount: 3,
      testimonialCount: 2,
      hasIntroVideo: true,
      introVideoOfferable: true,
    });
  });

  it("reports an empty page as empty", async () => {
    packageTemplateCount.mockResolvedValue(0);
    testimonialCount.mockResolvedValue(0);
    const signals = await pageSignalsFor({
      ...TEACHER,
      photoPath: null,
      headline: null,
      bio: null,
      introVideoPath: null,
    });
    expect(signals).toMatchObject({
      hasPhoto: false,
      hasIntroVideo: false,
      packageCount: 0,
      testimonialCount: 0,
    });
  });

  // A deploy with no video storage cannot accept one, so the gap must not be
  // raised against a teacher who has no way to close it.
  it("follows the deploy on whether a video can be asked for at all", async () => {
    introVideoStorageConfigured.mockReturnValue(false);
    expect((await pageSignalsFor(TEACHER)).introVideoOfferable).toBe(false);
  });
});
