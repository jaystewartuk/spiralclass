import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StorageProvider } from "@/lib/storage/provider";

// Tests for lib/storage/student-photo — the PRIVATE-bucket twin of
// teacher-photo.ts. Unlike the teacher's public bucket, every read here goes
// through a short-lived signed URL, never a stable public one.

const upload = vi.fn();
const remove = vi.fn();
const createSignedUrl = vi.fn();
const ensureBucket = vi.fn();
const publicUrl = vi.fn();

vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () =>
    ({
      upload,
      remove,
      createSignedUrl,
      ensureBucket,
      publicUrl,
    }) as StorageProvider,
}));

import {
  STUDENT_PHOTO_BUCKET,
  MAX_PHOTO_BYTES,
  ALLOWED_PHOTO_TYPES,
  studentPhotoStorageKey,
  studentPhotoUrl,
  ensureStudentPhotoBucket,
  putStudentPhoto,
  removeStudentPhoto,
} from "@/lib/storage/student-photo";

const STUDENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  upload.mockReset();
  remove.mockReset();
  createSignedUrl.mockReset();
  ensureBucket.mockReset();
  publicUrl.mockReset();
});

describe("constants", () => {
  it("uses a dedicated private bucket", () => {
    expect(STUDENT_PHOTO_BUCKET).toBe("student-photos");
  });

  it("caps at 5 MB", () => {
    expect(MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024);
  });

  it("allows jpeg, png and webp", () => {
    expect(ALLOWED_PHOTO_TYPES).toMatchObject({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    });
  });
});

describe("studentPhotoStorageKey", () => {
  it("keys by student id, one object per student", () => {
    expect(studentPhotoStorageKey(STUDENT_ID)).toBe(STUDENT_ID);
  });
});

describe("studentPhotoUrl", () => {
  it("returns null without calling the provider when there's no path", async () => {
    expect(await studentPhotoUrl(null)).toBeNull();
    expect(await studentPhotoUrl(undefined)).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(publicUrl).not.toHaveBeenCalled();
  });

  it("mints a signed URL, not a public one", async () => {
    createSignedUrl.mockResolvedValue("https://signed.test/abc?sig=xyz");
    const url = await studentPhotoUrl(STUDENT_ID);
    expect(url).toBe("https://signed.test/abc?sig=xyz");
    expect(createSignedUrl).toHaveBeenCalledWith(STUDENT_PHOTO_BUCKET, STUDENT_ID, 300);
    expect(publicUrl).not.toHaveBeenCalled();
  });

  it("returns null when signing fails", async () => {
    createSignedUrl.mockResolvedValue(null);
    expect(await studentPhotoUrl(STUDENT_ID)).toBeNull();
  });
});

describe("ensureStudentPhotoBucket", () => {
  it("provisions the bucket as PRIVATE", async () => {
    await ensureStudentPhotoBucket();
    expect(ensureBucket).toHaveBeenCalledWith(STUDENT_PHOTO_BUCKET, {
      public: false,
      fileSizeLimit: MAX_PHOTO_BYTES,
      allowedMimeTypes: Object.keys(ALLOWED_PHOTO_TYPES),
    });
  });
});

describe("putStudentPhoto", () => {
  it("uploads to the student-photos bucket keyed by student id", async () => {
    upload.mockResolvedValue({ error: null });
    const file = new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" });
    const result = await putStudentPhoto(STUDENT_ID, file);

    expect(ensureBucket).toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith(STUDENT_PHOTO_BUCKET, STUDENT_ID, file, {
      contentType: "image/jpeg",
      upsert: true,
    });
    expect(result).toEqual({ path: STUDENT_ID, error: null });
  });

  it("surfaces a provider error", async () => {
    upload.mockResolvedValue({ error: { message: "bucket offline" } });
    const file = new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" });
    const result = await putStudentPhoto(STUDENT_ID, file);
    expect(result).toEqual({ path: STUDENT_ID, error: "bucket offline" });
  });
});

describe("removeStudentPhoto", () => {
  it("calls remove on the bucket with the given path", async () => {
    remove.mockResolvedValue({ error: null });
    await removeStudentPhoto(STUDENT_ID);
    expect(remove).toHaveBeenCalledWith(STUDENT_PHOTO_BUCKET, [STUDENT_ID]);
  });

  it("swallows errors (best-effort)", async () => {
    remove.mockRejectedValue(new Error("network error"));
    await expect(removeStudentPhoto(STUDENT_ID)).resolves.toBeUndefined();
  });
});
