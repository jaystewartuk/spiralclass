import { describe, it, expect, vi } from "vitest";
import { seedTeacherPhoto, seedTeacherIntroVideo, type SeedDeps } from "../../scripts/seed";
import { teacherPhotoStorageKey } from "@/lib/storage/teacher-photo";
import { teacherVideoStorageKey } from "@/lib/storage/teacher-video";

// The regression these tests exist for: every seeded teacher's `photo_path`
// (and the one seeded `intro_video_path`) used to be a hardcoded key — the
// production teacher's objects — which the seed never uploaded anywhere.
// Preview and production have separate teacher-photos/teacher-videos buckets,
// so on preview those pointers 404'd. Neither read path has a 404 fallback:
// the booking-page hero and AccountAvatar branch on the URL being null, and
// IntroVideoCard renders whenever the path is non-null. So preview showed a
// broken image on every seeded teacher and a dead video card on Paula's page.
//
// The invariant that fixes it, and the one asserted here: the seed only ever
// points a teacher at an object it uploaded FOR THAT TEACHER, under that
// teacher's own storage key.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEACHER_ID = "9f1c0d3a-2b44-4f5e-8a71-6c0e2d9b7a13";

function fakeDeps(overrides: Partial<SeedDeps> = {}): SeedDeps {
  return {
    provisionTeacherAuthUser: vi.fn(async () => TEACHER_ID),
    ensureStudentAuthUser: vi.fn(async () => {}),
    uploadMaterial: vi.fn(async () => ({ ok: true })),
    uploadTeacherPhoto: vi.fn(async () => ({ ok: true })),
    uploadTeacherVideo: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("seedTeacherPhoto", () => {
  it("uploads PNG bytes under the teacher's own key and points her at it", async () => {
    const deps = fakeDeps();
    const path = await seedTeacherPhoto(deps, TEACHER_ID, "Alicia Moreno", "mira@seed.test");

    expect(path).toBe(teacherPhotoStorageKey(TEACHER_ID));
    expect(deps.uploadTeacherPhoto).toHaveBeenCalledTimes(1);

    const [uploadedId, png] = vi.mocked(deps.uploadTeacherPhoto).mock.calls[0]!;
    expect(uploadedId).toBe(TEACHER_ID);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  }, 30_000);

  it("never returns a key it did not derive from the teacher id", async () => {
    const other = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
    const deps = fakeDeps();
    const a = await seedTeacherPhoto(deps, TEACHER_ID, "One", "one@seed.test");
    const b = await seedTeacherPhoto(deps, other, "Two", "two@seed.test");
    expect(a).not.toBe(b);
    expect(b).toBe(teacherPhotoStorageKey(other));
  }, 30_000);

  it("still returns the path when the upload fails, so hasPhoto survives a credential-less env", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = fakeDeps({
      uploadTeacherPhoto: vi.fn(async () => ({ ok: false, error: "no bucket" })),
    });

    const path = await seedTeacherPhoto(deps, TEACHER_ID, "Mira", "mira@seed.test");

    // Safe because a null photo URL degrades to the initials monogram, and
    // isPubliclyListed()'s hasPhoto signal must not depend on R2 credentials.
    expect(path).toBe(teacherPhotoStorageKey(TEACHER_ID));
    // Announced, not swallowed — a silent failure here is the original bug.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no bucket"));
    warn.mockRestore();
  }, 30_000);
});

describe("seedTeacherIntroVideo", () => {
  it("uploads a real MP4 under the teacher's own key and points her at it", async () => {
    const deps = fakeDeps();
    const path = await seedTeacherIntroVideo(deps, TEACHER_ID, "paula@seed.test");

    expect(path).toBe(teacherVideoStorageKey(TEACHER_ID));

    const [uploadedId, mp4] = vi.mocked(deps.uploadTeacherVideo).mock.calls[0]!;
    expect(uploadedId).toBe(TEACHER_ID);
    expect(mp4.toString("latin1", 4, 8)).toBe("ftyp");
  });

  it("returns null when the upload fails, rather than a pointer to nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = fakeDeps({
      uploadTeacherVideo: vi.fn(async () => ({ ok: false, error: "no bucket" })),
    });

    // The asymmetry with the photo above is the point: IntroVideoCard has no
    // fallback, so a path that outlives its object renders a dead video card.
    // No video section at all is the better failure.
    expect(await seedTeacherIntroVideo(deps, TEACHER_ID, "paula@seed.test")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no bucket"));
    warn.mockRestore();
  });
});
