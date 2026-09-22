import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The storage module. Small, but it encodes two decisions worth pinning: the
// object key layout (which is what keeps these out of a new bucket and inside
// the teacher's own prefix) and the immutable cache header (safe ONLY because
// the key is uuid-derived and never reused).

const upload = vi.fn();
const remove = vi.fn();
vi.mock("@/lib/storage/provider", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/storage/provider");
  return { ...actual, getStorageProvider: () => ({ upload, remove }) };
});
vi.mock("@/lib/storage/r2-public-url", () => ({
  r2PublicUrl: (bucket: string, path: string | null) =>
    path ? `https://cdn.example/${bucket}/${path}` : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  upload.mockResolvedValue({ error: null });
  remove.mockResolvedValue({ error: null });
});

describe("social-preview storage", () => {
  it("keys objects under the teacher's own prefix in the EXISTING public bucket", async () => {
    const m = await import("@/lib/storage/social-preview-image");
    // Same bucket as teacher photos and testimonial avatars: it is already
    // public (crawlers fetch og:image unauthenticated), already CDN-fronted and
    // already provisioned, so a new bucket would be pure infra churn.
    expect(m.SOCIAL_PREVIEW_BUCKET).toBe("teacher-photos");
    expect(m.socialPreviewStorageKey("t1", "img-1", "png")).toBe("t1/social/img-1.png");
  });

  it("builds a credential-free public URL, and null for no path", async () => {
    const m = await import("@/lib/storage/social-preview-image");
    expect(m.socialPreviewImagePublicUrl("t1/social/img-1.png")).toBe(
      "https://cdn.example/teacher-photos/t1/social/img-1.png",
    );
    expect(m.socialPreviewImagePublicUrl(null)).toBeNull();
  });

  it("stores immutably and refuses to clobber — the key is never reused", async () => {
    const m = await import("@/lib/storage/social-preview-image");
    const result = await m.putSocialPreviewImage({
      teacherId: "t1",
      imageId: "img-1",
      extension: "png",
      contentType: "image/png",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(result).toEqual({ path: "t1/social/img-1.png", error: null });

    const [bucket, path, , opts] = upload.mock.calls[0];
    expect(bucket).toBe("teacher-photos");
    expect(path).toBe("t1/social/img-1.png");
    // upsert:false makes a collision loud rather than silently replacing
    // somebody's live preview.
    expect(opts.upsert).toBe(false);
    expect(opts.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("surfaces a storage error instead of pretending it stored", async () => {
    upload.mockResolvedValue({ error: { message: "r2-put-http-500" } });
    const m = await import("@/lib/storage/social-preview-image");
    const result = await m.putSocialPreviewImage({
      teacherId: "t1",
      imageId: "img-1",
      extension: "png",
      contentType: "image/png",
      body: new Uint8Array([1]),
    });
    expect(result.error).toBe("r2-put-http-500");
  });

  it("removal is best-effort — a storage failure must not strand a row delete", async () => {
    remove.mockRejectedValue(new Error("network"));
    const m = await import("@/lib/storage/social-preview-image");
    await expect(m.removeSocialPreviewImage("t1/social/img-1.png")).resolves.toBeUndefined();
  });
});

describe("image-gen seam", () => {
  it("reports not-configured rather than throwing when no provider has credentials", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({ hasGeminiImageCreds: () => false }));
    const { generateImage } = await import("@/lib/ai/image-gen");
    expect(await generateImage("a prompt")).toEqual({ ok: false, reason: "not-configured" });
  });

  it("routes to the Gemini adapter when its credentials are present", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({ hasGeminiImageCreds: () => true }));
    const generateWithGemini = vi.fn(async () => ({
      ok: false as const,
      reason: "empty" as const,
    }));
    vi.doMock("@/lib/ai/gemini-image", () => ({ generateWithGemini }));
    const { generateImage } = await import("@/lib/ai/image-gen");
    await generateImage("a prompt", { aspectRatio: "16:9" });
    expect(generateWithGemini).toHaveBeenCalledWith("a prompt", { aspectRatio: "16:9" });
  });
});
