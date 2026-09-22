import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { StorageProvider } from "@/lib/storage/provider";

// Tests for lib/storage/teacher-video — the public-bucket helper for a teacher's
// intro video (D-73). Mirrors teacher-photo / testimonial-photos: one object per
// teacher, replace in place, permanent public URL for the /b/<slug> page.

const upload = vi.fn();
const remove = vi.fn();
const ensureBucket = vi.fn();

// Keep the real r2BucketConfig / r2ObjectPath (they read env, exercised by the
// presign tests below) and only stub getStorageProvider for the buffered path.
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
  TEACHER_VIDEO_BUCKET,
  MAX_VIDEO_BYTES,
  ALLOWED_VIDEO_TYPES,
  teacherVideoStorageKey,
  teacherVideoPublicUrl,
  introVideoStorageConfigured,
  putTeacherVideo,
  removeTeacherVideo,
  presignTeacherVideoUpload,
  headTeacherVideoObject,
} from "@/lib/storage/teacher-video";

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  upload.mockReset();
  remove.mockReset();
  ensureBucket.mockReset();
});

describe("constants", () => {
  it("uses a dedicated public teacher-videos bucket", () => {
    expect(TEACHER_VIDEO_BUCKET).toBe("teacher-videos");
  });

  it("caps at 50 MB", () => {
    expect(MAX_VIDEO_BYTES).toBe(50 * 1024 * 1024);
  });

  it("allows mp4, webm and mov (with codec-suffixed webm variants)", () => {
    expect(ALLOWED_VIDEO_TYPES).toMatchObject({
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/quicktime": "mov",
      "video/webm;codecs=vp9,opus": "webm",
    });
  });
});

describe("teacherVideoStorageKey", () => {
  it("is the bare teacher id (one object per teacher, replace in place)", () => {
    expect(teacherVideoStorageKey(TEACHER_ID)).toBe(TEACHER_ID);
  });
});

describe("teacherVideoPublicUrl / introVideoStorageConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null (and reports unconfigured) when the R2 public base is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL", "");
    expect(introVideoStorageConfigured()).toBe(false);
    expect(teacherVideoPublicUrl(TEACHER_ID)).toBeNull();
  });

  it("builds a version-stamped public URL when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL", "https://vid-abc.r2.dev");
    expect(introVideoStorageConfigured()).toBe(true);
    expect(teacherVideoPublicUrl(TEACHER_ID, 1234)).toBe(
      `https://vid-abc.r2.dev/${TEACHER_ID}?v=1234`,
    );
  });

  it("returns null for a null / undefined path even when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL", "https://vid-abc.r2.dev");
    expect(teacherVideoPublicUrl(null)).toBeNull();
    expect(teacherVideoPublicUrl(undefined)).toBeNull();
  });
});

describe("putTeacherVideo", () => {
  function makeFile(type: string, size: number) {
    return new File([new Uint8Array(size)], "intro.mp4", { type });
  }

  it("provisions the bucket then upserts one object keyed by teacher id", async () => {
    upload.mockResolvedValue({ error: null });
    const file = makeFile("video/mp4", 2048);
    const result = await putTeacherVideo(TEACHER_ID, file, "video/mp4");

    expect(ensureBucket).toHaveBeenCalledWith(
      TEACHER_VIDEO_BUCKET,
      expect.objectContaining({ public: true }),
    );
    expect(upload).toHaveBeenCalledWith(TEACHER_VIDEO_BUCKET, TEACHER_ID, file, {
      contentType: "video/mp4",
      upsert: true,
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(result).toEqual({ path: TEACHER_ID, error: null });
  });

  it("surfaces the provider error message", async () => {
    upload.mockResolvedValue({ error: { message: "bucket offline" } });
    const result = await putTeacherVideo(TEACHER_ID, makeFile("video/mp4", 1), "video/mp4");
    expect(result).toEqual({ path: TEACHER_ID, error: "bucket offline" });
  });
});

describe("removeTeacherVideo", () => {
  it("hard-deletes the object, best-effort (swallows errors)", async () => {
    remove.mockResolvedValue({ error: null });
    await removeTeacherVideo(TEACHER_ID);
    expect(remove).toHaveBeenCalledWith(TEACHER_VIDEO_BUCKET, [TEACHER_ID]);

    remove.mockRejectedValue(new Error("network"));
    await expect(removeTeacherVideo(TEACHER_ID)).resolves.toBeUndefined();
  });
});

describe("presignTeacherVideoUpload (direct-to-R2)", () => {
  afterEach(() => vi.unstubAllEnvs());

  function stubR2() {
    vi.stubEnv("TEACHER_VIDEOS_R2_BUCKET", "agendaprofe-teacher-videos");
    vi.stubEnv("TEACHER_VIDEOS_R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com");
    vi.stubEnv("TEACHER_VIDEOS_R2_ACCESS_KEY", "ak");
    vi.stubEnv("TEACHER_VIDEOS_R2_SECRET", "sk");
  }

  it("mints a presigned PUT to the teacher's own key when configured", () => {
    stubR2();
    const res = presignTeacherVideoUpload(TEACHER_ID, "video/mp4");
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.storagePath).toBe(TEACHER_ID); // server-derived key = teacher id
    expect(res.uploadUrl).toContain("acc.r2.cloudflarestorage.com");
    expect(res.uploadUrl).toContain(`/agendaprofe-teacher-videos/${TEACHER_ID}`);
    expect(res.uploadUrl).toContain("X-Amz-Signature=");
  });

  it("rejects a disallowed content type", () => {
    stubR2();
    expect(presignTeacherVideoUpload(TEACHER_ID, "application/octet-stream")).toEqual({
      error: "bad-type",
    });
  });

  it("reports r2-not-configured when the bucket env is missing", () => {
    vi.stubEnv("TEACHER_VIDEOS_R2_BUCKET", "");
    expect(presignTeacherVideoUpload(TEACHER_ID, "video/mp4")).toEqual({
      error: "r2-not-configured",
    });
  });
});

describe("headTeacherVideoObject", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubR2() {
    vi.stubEnv("TEACHER_VIDEOS_R2_BUCKET", "b");
    vi.stubEnv("TEACHER_VIDEOS_R2_ENDPOINT", "https://acc.r2.cloudflarestorage.com");
    vi.stubEnv("TEACHER_VIDEOS_R2_ACCESS_KEY", "ak");
    vi.stubEnv("TEACHER_VIDEOS_R2_SECRET", "sk");
  }

  it("returns the object's byte size from the Content-Length header", async () => {
    stubR2();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, headers: new Headers({ "content-length": "2048" }) })),
    );
    expect(await headTeacherVideoObject(TEACHER_ID)).toBe(2048);
  });

  it("returns null when the object doesn't exist (non-2xx)", async () => {
    stubR2();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, headers: new Headers() })),
    );
    expect(await headTeacherVideoObject(TEACHER_ID)).toBeNull();
  });

  it("returns null when R2 isn't configured", async () => {
    vi.stubEnv("TEACHER_VIDEOS_R2_BUCKET", "");
    expect(await headTeacherVideoObject(TEACHER_ID)).toBeNull();
  });
});
