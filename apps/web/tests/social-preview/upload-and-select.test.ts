import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Upload validation and the ONE write that can point a public surface at an
// asset. Cross-teacher isolation is the property that matters most here: a
// booking page is public, so a preview pointing at somebody else's image would
// leak it to every crawler that scrapes the link.

const upload = vi.fn();
const imageFindFirst = vi.fn();
const imageCreate = vi.fn();
const groupFindFirst = vi.fn();
const previewUpsert = vi.fn();
const previewFindFirst = vi.fn();
const previewUpdate = vi.fn();
const previewCreate = vi.fn();
const previewDeleteMany = vi.fn();

vi.mock("@/lib/prisma", () => {
  const tx = {
    socialPreview: {
      findFirst: (...a: unknown[]) => previewFindFirst(...a),
      update: (...a: unknown[]) => previewUpdate(...a),
      create: (...a: unknown[]) => previewCreate(...a),
    },
  };
  return {
    prisma: {
      socialPreviewImage: { findFirst: imageFindFirst, create: imageCreate, count: vi.fn() },
      teacherShareGroup: { findFirst: groupFindFirst },
      socialPreview: {
        upsert: previewUpsert,
        findFirst: previewFindFirst,
        deleteMany: previewDeleteMany,
        findMany: vi.fn(),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "https://spiralclass.com" }) }));
vi.mock("@/lib/storage/social-preview-image", () => ({
  putSocialPreviewImage: upload,
  socialPreviewImagePublicUrl: (p: string | null) => (p ? `https://cdn.example/${p}` : null),
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

function file(type: string, size: number): File {
  // A real File would allocate `size` bytes; the validator only reads .size
  // and .type, so this stays cheap even for the over-limit case.
  return { type, size } as File;
}

const PREVIEW_ROW = {
  id: "preview-1",
  shareGroupId: null,
  caption: "hola",
  updatedAt: new Date("2026-08-22T00:00:00Z"),
  image: {
    id: "img-1",
    source: "ai",
    angle: "meme",
    topic: null,
    storagePath: "t1/social/img-1.png",
    createdAt: new Date("2026-08-22T00:00:00Z"),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  upload.mockResolvedValue({ path: "t1/social/img-1.png", error: null });
  imageCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: data.id,
    source: data.source,
    angle: data.angle,
    topic: data.topic,
    storagePath: data.storagePath,
    createdAt: new Date("2026-08-22T00:00:00Z"),
  }));
});

describe("uploadSocialPreviewImage", () => {
  async function run(f: File) {
    const { uploadSocialPreviewImage } = await import("@/lib/social-preview/upload");
    return uploadSocialPreviewImage({ teacherId: "t1", file: f });
  }

  it("accepts a normal JPEG and records it as an `upload`, sharing the AI asset model", async () => {
    const result = await run(file("image/jpeg", 1024));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.source).toBe("upload");
    // No angle invented for her — that would put a guess into the very
    // dimension the analytics breakdown is built on.
    expect(result.image.angle).toBeNull();
  });

  it("rejects a disguised SVG by DECLARED type, never by filename", async () => {
    expect(await run(file("image/svg+xml", 1024))).toEqual({ ok: false, reason: "type" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an empty file and an oversized one before touching storage", async () => {
    expect(await run(file("image/png", 0))).toEqual({ ok: false, reason: "empty" });
    expect(await run(file("image/png", 6 * 1024 * 1024))).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("derives the stored extension from the content type", async () => {
    await run(file("image/webp", 2048));
    expect(upload.mock.calls[0][0].extension).toBe("webp");
  });

  it("writes no row when storage fails", async () => {
    upload.mockResolvedValue({ path: "", error: "r2-put-http-500" });
    expect(await run(file("image/png", 1024))).toEqual({ ok: false, reason: "storage" });
    expect(imageCreate).not.toHaveBeenCalled();
  });

  it("is not capped — a teacher who exhausts her AI allowance can still upload", async () => {
    for (let i = 0; i < 30; i++) expect((await run(file("image/png", 1024))).ok).toBe(true);
  });
});

describe("selectSocialPreview — cross-teacher isolation", () => {
  async function select(over: Record<string, unknown> = {}) {
    const { selectSocialPreview } = await import("@/lib/social-preview/store");
    return selectSocialPreview({
      teacherId: "t1",
      imageId: "11111111-1111-1111-1111-111111111111",
      shareGroupId: null,
      caption: "hola",
      ...over,
    });
  }

  it("refuses an image belonging to another teacher", async () => {
    // findFirst is scoped by { id, teacherId }, so another teacher's image
    // simply isn't found.
    imageFindFirst.mockResolvedValue(null);
    expect(await select()).toEqual({ ok: false, reason: "image-not-found" });
    expect(previewUpsert).not.toHaveBeenCalled();
    expect(previewCreate).not.toHaveBeenCalled();
  });

  it("refuses a share group belonging to another teacher", async () => {
    imageFindFirst.mockResolvedValue({ id: "img-1" });
    groupFindFirst.mockResolvedValue(null);
    expect(await select({ shareGroupId: "22222222-2222-2222-2222-222222222222" })).toEqual({
      ok: false,
      reason: "group-not-found",
    });
    expect(previewUpsert).not.toHaveBeenCalled();
  });

  it("upserts the per-group placement when both belong to the teacher", async () => {
    imageFindFirst.mockResolvedValue({ id: "img-1" });
    groupFindFirst.mockResolvedValue({ id: "g1" });
    previewUpsert.mockResolvedValue({ ...PREVIEW_ROW, shareGroupId: "g1" });
    const result = await select({ shareGroupId: "22222222-2222-2222-2222-222222222222" });
    expect(result.ok).toBe(true);
    expect(previewUpsert).toHaveBeenCalledTimes(1);
  });

  it("updates the existing default row rather than creating a second one", async () => {
    // Postgres allows many NULLs under a unique index, so single-default is an
    // application-layer guarantee — this is the test that holds it.
    imageFindFirst.mockResolvedValue({ id: "img-1" });
    previewFindFirst.mockResolvedValue({ id: "preview-1" });
    previewUpdate.mockResolvedValue(PREVIEW_ROW);
    const result = await select();
    expect(result.ok).toBe(true);
    expect(previewUpdate).toHaveBeenCalledTimes(1);
    expect(previewCreate).not.toHaveBeenCalled();
  });

  it("creates the default row the first time", async () => {
    imageFindFirst.mockResolvedValue({ id: "img-1" });
    previewFindFirst.mockResolvedValue(null);
    previewCreate.mockResolvedValue(PREVIEW_ROW);
    expect((await select()).ok).toBe(true);
    expect(previewCreate).toHaveBeenCalledTimes(1);
  });

  it("bounds the caption on the way in", async () => {
    imageFindFirst.mockResolvedValue({ id: "img-1" });
    previewFindFirst.mockResolvedValue(null);
    previewCreate.mockResolvedValue(PREVIEW_ROW);
    await select({ caption: "x".repeat(500) });
    expect(previewCreate.mock.calls[0][0].data.caption.length).toBe(120);
  });
});

describe("clearSocialPreview", () => {
  it("scopes the delete to the owning teacher and keeps the image", async () => {
    previewDeleteMany.mockResolvedValue({ count: 1 });
    const { clearSocialPreview } = await import("@/lib/social-preview/store");
    expect(await clearSocialPreview("t1", "preview-1")).toBe(true);
    expect(previewDeleteMany).toHaveBeenCalledWith({
      where: { id: "preview-1", teacherId: "t1" },
    });
  });

  it("reports not-found rather than succeeding on another teacher's preview", async () => {
    previewDeleteMany.mockResolvedValue({ count: 0 });
    const { clearSocialPreview } = await import("@/lib/social-preview/store");
    expect(await clearSocialPreview("t1", "someone-elses")).toBe(false);
  });
});
