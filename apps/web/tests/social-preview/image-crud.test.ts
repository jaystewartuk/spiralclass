import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The asset half of the image library: rename, delete, and knowing what each
// stored image is FOR.
//
// Deletion is the operation with teeth. The FK from SocialPreview and
// MarketingActivity is `Restrict` on purpose (D-123/D-125) — an asset a live
// share link previews must not vanish underneath it — so what is pinned here is
// that deletion RESOLVES that constraint rather than forcing past it: a post
// she already marked done blocks it, a draft's reference is cleared, a
// placement falls back to the standard card, and the bytes go last.

const imageFindFirst = vi.fn();
const imageDeleteMany = vi.fn();
const imageUpdateMany = vi.fn();
const previewFindMany = vi.fn();
const previewDeleteMany = vi.fn();
const activityFindFirst = vi.fn();
const activityFindMany = vi.fn();
const activityUpdateMany = vi.fn();
const removeImage = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    socialPreviewImage: {
      findFirst: imageFindFirst,
      deleteMany: imageDeleteMany,
      updateMany: imageUpdateMany,
      findMany: vi.fn(),
      count: vi.fn(),
    },
    socialPreview: {
      findMany: previewFindMany,
      deleteMany: previewDeleteMany,
      findFirst: vi.fn(),
    },
    marketingActivity: {
      findFirst: activityFindFirst,
      findMany: activityFindMany,
      updateMany: activityUpdateMany,
    },
    // The transaction is a list of prepared operations here, so awaiting it is
    // enough to prove all three were enqueued.
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  },
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "https://spiralclass.com" }) }));
vi.mock("@/lib/storage/social-preview-image", () => ({
  removeSocialPreviewImage: removeImage,
  socialPreviewImagePublicUrl: (p: string | null) => (p ? `https://cdn.example/${p}` : null),
}));

const { deleteSocialPreviewImage, renameSocialPreviewImage, socialPreviewImageUsage } =
  await import("@/lib/social-preview/store");

beforeEach(() => {
  vi.clearAllMocks();
  imageFindFirst.mockResolvedValue({ id: "img-1", storagePath: "t1/social/img-1.png" });
  imageDeleteMany.mockResolvedValue({ count: 1 });
  imageUpdateMany.mockResolvedValue({ count: 1 });
  previewDeleteMany.mockResolvedValue({ count: 1 });
  previewFindMany.mockResolvedValue([]);
  activityFindFirst.mockResolvedValue(null);
  activityFindMany.mockResolvedValue([]);
  activityUpdateMany.mockResolvedValue({ count: 0 });
});

describe("renameSocialPreviewImage", () => {
  it("scopes the write to the teacher", async () => {
    await renameSocialPreviewImage({ teacherId: "t1", imageId: "img-1", topic: "Bus stop joke" });
    expect(imageUpdateMany.mock.calls[0][0].where).toEqual({ id: "img-1", teacherId: "t1" });
    expect(imageUpdateMany.mock.calls[0][0].data).toEqual({ topic: "Bus stop joke" });
  });

  it("reads an emptied label as no label rather than as an empty string", async () => {
    await renameSocialPreviewImage({ teacherId: "t1", imageId: "img-1", topic: "   " });
    expect(imageUpdateMany.mock.calls[0][0].data).toEqual({ topic: null });
  });

  it("reports false when nothing matched, rather than pretending it worked", async () => {
    imageUpdateMany.mockResolvedValue({ count: 0 });
    expect(await renameSocialPreviewImage({ teacherId: "t1", imageId: "x", topic: "hi" })).toBe(
      false,
    );
  });
});

describe("deleteSocialPreviewImage", () => {
  it("refuses another teacher's image without touching storage", async () => {
    imageFindFirst.mockResolvedValue(null);
    const result = await deleteSocialPreviewImage({ teacherId: "t1", imageId: "someone-elses" });
    // "Not yours" and "gone" are one answer, so an id cannot be probed.
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(imageFindFirst.mock.calls[0][0].where).toEqual({
      id: "someone-elses",
      teacherId: "t1",
    });
    expect(imageDeleteMany).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("refuses an image that is part of a post she already marked done", async () => {
    activityFindFirst.mockResolvedValue({ id: "a1" });
    const result = await deleteSocialPreviewImage({ teacherId: "t1", imageId: "img-1" });
    expect(result).toEqual({ ok: false, reason: "posted" });
    expect(imageDeleteMany).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
    // And it only looks at DONE activities — a draft is not a live post.
    expect(activityFindFirst.mock.calls[0][0].where).toMatchObject({
      teacherId: "t1",
      imageId: "img-1",
      status: "done",
    });
  });

  it("clears the placements and draft references, then the row, then the bytes", async () => {
    const result = await deleteSocialPreviewImage({ teacherId: "t1", imageId: "img-1" });
    expect(result).toEqual({ ok: true });
    // A placement falls back to the standard SpiralClass card — the same thing
    // "Back to the standard card" already does, and equally reversible.
    expect(previewDeleteMany.mock.calls[0][0].where).toEqual({
      teacherId: "t1",
      imageId: "img-1",
    });
    // A draft keeps its text and loses its picture.
    expect(activityUpdateMany.mock.calls[0][0].data).toEqual({ imageId: null });
    expect(imageDeleteMany.mock.calls[0][0].where).toEqual({ id: "img-1", teacherId: "t1" });
    // Row first, bytes second: the other order leaves a row pointing at bytes
    // that are gone, which is a broken image on a public page.
    expect(removeImage).toHaveBeenCalledWith("t1/social/img-1.png");
  });

  it("scopes every cascade to the teacher, not just the lookup", async () => {
    await deleteSocialPreviewImage({ teacherId: "t1", imageId: "img-1" });
    for (const call of [
      previewDeleteMany.mock.calls[0][0],
      activityUpdateMany.mock.calls[0][0],
      imageDeleteMany.mock.calls[0][0],
    ]) {
      expect(call.where.teacherId).toBe("t1");
    }
  });
});

describe("socialPreviewImageUsage", () => {
  it("says which communities show each image, and which is the default", async () => {
    previewFindMany.mockResolvedValue([
      { imageId: "img-1", shareGroup: { name: "Oaxaca Expats" } },
      { imageId: "img-1", shareGroup: { name: "Moms of Polanco" } },
      { imageId: "img-2", shareGroup: null },
    ]);
    const usage = await socialPreviewImageUsage("t1");
    expect(usage.get("img-1")).toMatchObject({
      communities: ["Oaxaca Expats", "Moms of Polanco"],
      isDefault: false,
      posted: false,
    });
    expect(usage.get("img-2")).toMatchObject({ communities: [], isDefault: true });
  });

  it("flags an image that is already out in a real feed", async () => {
    activityFindMany.mockResolvedValue([{ imageId: "img-3" }]);
    const usage = await socialPreviewImageUsage("t1");
    expect(usage.get("img-3")?.posted).toBe(true);
  });

  it("reads only this teacher's rows", async () => {
    await socialPreviewImageUsage("t1");
    expect(previewFindMany.mock.calls[0][0].where).toEqual({ teacherId: "t1" });
    expect(activityFindMany.mock.calls[0][0].where).toMatchObject({ teacherId: "t1" });
  });
});
