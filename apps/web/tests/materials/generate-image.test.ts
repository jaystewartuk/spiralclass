import { beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "@spiralclass/shared";

// Generating an image for a material body. What is pinned: every cheap refusal
// runs before the paid provider call, a generated picture is stored through
// the same upload path (and checks) as a chosen one, and the teacher gets a
// message she can act on for each way it can fail.

vi.mock("server-only", () => ({}));

const generateImage = vi.fn();
const rateLimit = vi.fn();
const uploadMaterialImage = vi.fn();
const hasGeminiImageCreds = vi.fn(() => true);

vi.mock("@/lib/ai/image-gen", () => ({ generateImage }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/env", () => ({ hasGeminiImageCreds: () => hasGeminiImageCreds() }));
vi.mock("@/lib/storage/material-images", () => ({ uploadMaterialImage }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { generateMaterialImage } = await import("@/lib/materials/generate-image");
const { buildMaterialImagePrompt, MATERIAL_IMAGE_DESCRIPTION_MAX } =
  await import("@/lib/materials/image-prompt");

const t = createT("es");
const run = (description = "Una familia cenando en un restaurante") =>
  generateMaterialImage({ teacherId: "teacher-1", description, t });

const OK_IMAGE = {
  ok: true as const,
  image: {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
    provider: "gemini",
    model: "gemini-3.1-flash-image",
  },
};
const SRC = "material-image:teacher-1/library/images/x.png";

beforeEach(() => {
  vi.clearAllMocks();
  hasGeminiImageCreds.mockReturnValue(true);
  rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
  generateImage.mockResolvedValue(OK_IMAGE);
  uploadMaterialImage.mockResolvedValue({ ok: { src: SRC, key: "k" } });
});

describe("buildMaterialImagePrompt", () => {
  it("carries the teacher's description as she wrote it", () => {
    expect(buildMaterialImagePrompt("  Una familia   cenando ")).toContain(
      "The scene: Una familia cenando",
    );
  });

  it("asks for a realistic photograph unless the description asks otherwise", () => {
    // The first teacher to use these found illustrations childish for adults.
    expect(buildMaterialImagePrompt("a kitchen")).toMatch(/Unless the scene .* realistic/);
  });

  it("forbids writing in the picture", () => {
    // A misspelt sign in a language class is a wrong answer on the exercise.
    expect(buildMaterialImagePrompt("a street")).toMatch(/Do not put any text in the image/);
  });

  it("bounds the description", () => {
    const prompt = buildMaterialImagePrompt("x".repeat(MATERIAL_IMAGE_DESCRIPTION_MAX + 50));
    expect(prompt).toContain("x".repeat(MATERIAL_IMAGE_DESCRIPTION_MAX));
    expect(prompt).not.toContain("x".repeat(MATERIAL_IMAGE_DESCRIPTION_MAX + 1));
  });
});

describe("generateMaterialImage", () => {
  it("stores the picture through the upload path and returns its src", async () => {
    expect(await run()).toEqual({ ok: true, src: SRC });

    expect(generateImage).toHaveBeenCalledWith(
      expect.stringContaining("Una familia cenando en un restaurante"),
      { aspectRatio: "4:3" },
    );
    const { teacherId, file } = uploadMaterialImage.mock.calls[0][0];
    expect(teacherId).toBe("teacher-1");
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("calls no provider where none is configured", async () => {
    hasGeminiImageCreds.mockReturnValue(false);
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: "not-configured" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("throttles before the paid call, on the burst limit and on the day's budget", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 1000 });
    expect(await run()).toMatchObject({ ok: false, reason: "throttled" });

    rateLimit
      .mockResolvedValueOnce({ ok: true, retryAfterMs: 0 })
      .mockResolvedValueOnce({ ok: false, retryAfterMs: 1000 });
    expect(await run()).toMatchObject({ ok: false, reason: "throttled" });

    expect(generateImage).not.toHaveBeenCalled();
    const scopes = rateLimit.mock.calls.map(([, opts]) => opts.scope);
    expect(new Set(scopes)).toEqual(
      new Set(["material-image-generate", "material-image-generate-day"]),
    );
  });

  it("tells the teacher to rephrase when the provider refuses the brief", async () => {
    generateImage.mockResolvedValue({ ok: false, reason: "blocked" });
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    if (!result.ok) {
      expect(result.message).toBe(t("material.editor.block.imageGenerate.refused"));
    }
    expect(uploadMaterialImage).not.toHaveBeenCalled();
  });

  it("refuses a picture in a type the materials surfaces do not serve", async () => {
    generateImage.mockResolvedValue({
      ok: true,
      image: { ...OK_IMAGE.image, contentType: "image/svg+xml" },
    });
    expect(await run()).toMatchObject({ ok: false, reason: "error" });
    expect(uploadMaterialImage).not.toHaveBeenCalled();
  });

  it("reports a storage failure rather than a src that points at nothing", async () => {
    uploadMaterialImage.mockResolvedValue({ error: "upload failed" });
    expect(await run()).toMatchObject({ ok: false, reason: "storage" });
  });
});
