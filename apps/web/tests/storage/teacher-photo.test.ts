import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { StorageProvider } from "@/lib/storage/provider";

// Tests for lib/storage/teacher-photo — the public-bucket helper for a
// teacher's profile photo. One object per teacher, replace in place,
// permanent version-stamped public URL for the /b/<slug> page.

const upload = vi.fn();
const remove = vi.fn();
const ensureBucket = vi.fn();

vi.mock("@/lib/storage/provider", async (orig) => {
  const actual = await orig<typeof import("@/lib/storage/provider")>();
  return {
    ...actual,
    getStorageProvider: () =>
      ({
        upload,
        remove,
        publicUrl: vi.fn(),
        createSignedUrl: vi.fn(),
        ensureBucket,
      }) as StorageProvider,
  };
});

import {
  TEACHER_PHOTO_BUCKET,
  MAX_PHOTO_BYTES,
  ALLOWED_PHOTO_TYPES,
  teacherPhotoStorageKey,
  teacherPhotoPublicUrl,
  putTeacherPhoto,
  removeTeacherPhoto,
} from "@/lib/storage/teacher-photo";

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  upload.mockReset();
  remove.mockReset();
  ensureBucket.mockReset();
});

describe("constants", () => {
  it("uses a dedicated public teacher-photos bucket", () => {
    expect(TEACHER_PHOTO_BUCKET).toBe("teacher-photos");
  });

  it("caps at 5 MB", () => {
    expect(MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024);
  });

  it("allows jpeg, png and webp", () => {
    expect(ALLOWED_PHOTO_TYPES).toEqual({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    });
  });
});

describe("teacherPhotoStorageKey", () => {
  it("is the bare teacher id (one object per teacher, replace in place)", () => {
    expect(teacherPhotoStorageKey(TEACHER_ID)).toBe(TEACHER_ID);
  });
});

describe("teacherPhotoPublicUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when the R2 public base is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL", "");
    expect(teacherPhotoPublicUrl(TEACHER_ID)).toBeNull();
  });

  it("builds a version-stamped public URL when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL", "https://pub-abc.r2.dev");
    expect(teacherPhotoPublicUrl(TEACHER_ID, 1234)).toBe(
      `https://pub-abc.r2.dev/${TEACHER_ID}?v=1234`,
    );
  });

  it("returns null for a null / undefined path even when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL", "https://pub-abc.r2.dev");
    expect(teacherPhotoPublicUrl(null)).toBeNull();
    expect(teacherPhotoPublicUrl(undefined)).toBeNull();
  });
});

describe("putTeacherPhoto", () => {
  function makeFile(type: string, size: number) {
    return new File([new Uint8Array(size)], "photo.jpg", { type });
  }

  it("provisions the bucket then upserts one object keyed by teacher id, with a long immutable cache since the public URL is version-stamped", async () => {
    upload.mockResolvedValue({ error: null });
    const file = makeFile("image/jpeg", 2048);
    const result = await putTeacherPhoto(TEACHER_ID, file);

    expect(ensureBucket).toHaveBeenCalledWith(
      TEACHER_PHOTO_BUCKET,
      expect.objectContaining({ public: true }),
    );
    expect(upload).toHaveBeenCalledWith(TEACHER_PHOTO_BUCKET, TEACHER_ID, file, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(result).toEqual({ path: TEACHER_ID, error: null });
  });

  it("surfaces the provider error message", async () => {
    upload.mockResolvedValue({ error: { message: "bucket offline" } });
    const result = await putTeacherPhoto(TEACHER_ID, makeFile("image/jpeg", 1));
    expect(result).toEqual({ path: TEACHER_ID, error: "bucket offline" });
  });
});

describe("removeTeacherPhoto", () => {
  it("hard-deletes the object, best-effort (swallows errors)", async () => {
    remove.mockResolvedValue({ error: null });
    await removeTeacherPhoto(TEACHER_ID);
    expect(remove).toHaveBeenCalledWith(TEACHER_PHOTO_BUCKET, [TEACHER_ID]);

    remove.mockRejectedValue(new Error("network"));
    await expect(removeTeacherPhoto(TEACHER_ID)).resolves.toBeUndefined();
  });
});
