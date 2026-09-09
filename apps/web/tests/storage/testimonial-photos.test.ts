import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { StorageProvider } from "@/lib/storage/provider";

// Tests for lib/storage/testimonial-photos — the storage helper for optional
// author avatars on teacher-authored testimonials.

// Stub getStorageProvider() before importing the module under test.
const upload = vi.fn();
const remove = vi.fn();

vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () =>
    ({
      upload,
      remove,
      publicUrl: vi.fn(),
      createSignedUrl: vi.fn(),
      ensureBucket: vi.fn(),
    }) as StorageProvider,
}));

import {
  TESTIMONIAL_PHOTO_BUCKET,
  TESTIMONIAL_PHOTO_MAX_BYTES,
  ALLOWED_TESTIMONIAL_PHOTO_TYPES,
  testimonialPhotoStoragePath,
  testimonialPhotoPublicUrl,
  uploadTestimonialPhoto,
  removeTestimonialPhoto,
} from "@/lib/storage/testimonial-photos";

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  upload.mockReset();
  remove.mockReset();
});

describe("constants", () => {
  it("uses the teacher-photos public bucket", () => {
    expect(TESTIMONIAL_PHOTO_BUCKET).toBe("teacher-photos");
  });

  it("caps at 5 MB", () => {
    expect(TESTIMONIAL_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("allows jpeg, png and webp", () => {
    expect(ALLOWED_TESTIMONIAL_PHOTO_TYPES).toMatchObject({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    });
  });
});

describe("testimonialPhotoStoragePath", () => {
  it("namespaces under ${teacherId}/testimonials/${testimonialId}", () => {
    expect(testimonialPhotoStoragePath(TEACHER_ID, TEST_ID)).toBe(
      `${TEACHER_ID}/testimonials/${TEST_ID}`,
    );
  });
});

describe("testimonialPhotoPublicUrl", () => {
  // Reads NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL directly (lib/storage/r2-public-url,
  // not the mocked provider) — this helper is split into a pure module with no
  // provider.ts import specifically so the client component that renders it
  // doesn't pull node:crypto into the browser bundle. See r2-public-url.ts.
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL", "https://pub-abc123.r2.dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the public URL from the configured R2 base", () => {
    expect(testimonialPhotoPublicUrl("abc")).toBe("https://pub-abc123.r2.dev/abc");
  });

  it("returns null for a null / undefined path", () => {
    expect(testimonialPhotoPublicUrl(null)).toBeNull();
    expect(testimonialPhotoPublicUrl(undefined)).toBeNull();
  });
});

describe("uploadTestimonialPhoto", () => {
  function makeFile(type: string, size: number) {
    const buf = new Uint8Array(size);
    return new File([buf], "photo.jpg", { type });
  }

  it("uploads to the teacher-photos bucket under the expected path", async () => {
    upload.mockResolvedValue({ error: null });
    const file = makeFile("image/jpeg", 1024);
    const result = await uploadTestimonialPhoto(TEACHER_ID, TEST_ID, file);

    expect(upload).toHaveBeenCalledWith(
      TESTIMONIAL_PHOTO_BUCKET,
      `${TEACHER_ID}/testimonials/${TEST_ID}`,
      file,
      { contentType: "image/jpeg", upsert: true },
    );
    expect(result).toEqual({
      storagePath: `${TEACHER_ID}/testimonials/${TEST_ID}`,
      error: null,
    });
  });

  it("returns an error string when the provider fails", async () => {
    upload.mockResolvedValue({ error: { message: "bucket offline" } });
    const file = makeFile("image/jpeg", 1024);
    const result = await uploadTestimonialPhoto(TEACHER_ID, TEST_ID, file);

    expect(result).toEqual({ storagePath: null, error: "bucket offline" });
  });
});

describe("removeTestimonialPhoto", () => {
  it("calls remove on the bucket with the given path", async () => {
    remove.mockResolvedValue({ error: null });
    await removeTestimonialPhoto(`${TEACHER_ID}/testimonials/${TEST_ID}`);
    expect(remove).toHaveBeenCalledWith(TESTIMONIAL_PHOTO_BUCKET, [
      `${TEACHER_ID}/testimonials/${TEST_ID}`,
    ]);
  });

  it("swallows errors (best-effort)", async () => {
    remove.mockRejectedValue(new Error("network error"));
    // Should not throw
    await expect(
      removeTestimonialPhoto(`${TEACHER_ID}/testimonials/${TEST_ID}`),
    ).resolves.toBeUndefined();
  });
});
