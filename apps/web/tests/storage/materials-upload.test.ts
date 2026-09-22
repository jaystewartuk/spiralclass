import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the storage provider so file uploads don't hit a real backend. The
// link / size / missing-attachment paths never call the provider.
const upload = vi.fn(async () => ({ error: null }));
const remove = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () => ({ upload, remove }),
}));

import {
  MAX_MATERIAL_BYTES,
  removeMaterialObject,
  resolveMaterialAttachment,
} from "@/lib/storage/materials-upload";
import { MATERIALS_BUCKET } from "@/lib/storage/signed-urls";

afterEach(() => vi.clearAllMocks());

describe("resolveMaterialAttachment", () => {
  it("accepts a valid link and never touches storage", async () => {
    const res = await resolveMaterialAttachment({
      file: null,
      linkUrl: "  https://example.com/x.pdf  ",
      pathPrefix: "t1/library",
      en: true,
    });
    expect(res).toEqual({ ok: { kind: "link", linkUrl: "https://example.com/x.pdf" } });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an invalid link", async () => {
    const res = await resolveMaterialAttachment({
      file: null,
      linkUrl: "not-a-url",
      pathPrefix: "t1/library",
      en: true,
    });
    expect("error" in res).toBe(true);
  });

  it("errors when neither file nor link is provided", async () => {
    const res = await resolveMaterialAttachment({
      file: null,
      linkUrl: "",
      pathPrefix: "t1/library",
      en: true,
    });
    expect("error" in res).toBe(true);
  });

  it("rejects an oversized file before uploading", async () => {
    const big = new File([new Uint8Array(MAX_MATERIAL_BYTES + 1)], "big.pdf");
    const res = await resolveMaterialAttachment({
      file: big,
      linkUrl: "",
      pathPrefix: "t1/library",
      en: true,
    });
    expect("error" in res).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads a valid file under the given prefix and returns its storage path", async () => {
    const small = new File([new Uint8Array(10)], "lesson.pdf", { type: "application/pdf" });
    const res = await resolveMaterialAttachment({
      file: small,
      linkUrl: "",
      pathPrefix: "teacher-1/library",
      en: true,
    });
    expect("ok" in res).toBe(true);
    if ("ok" in res && res.ok.kind === "file") {
      // Library prefix keeps these out of the per-class 60-day purge.
      expect(res.ok.storagePath.startsWith("teacher-1/library/")).toBe(true);
      expect(res.ok.storagePath.endsWith("lesson.pdf")).toBe(true);
    }
    expect(upload).toHaveBeenCalledOnce();
  });
});

describe("removeMaterialObject", () => {
  it("removes the storage object (hard-delete frees storage)", async () => {
    await removeMaterialObject("teacher-1/library/x.pdf");
    expect(remove).toHaveBeenCalledWith(MATERIALS_BUCKET, ["teacher-1/library/x.pdf"]);
  });
});
