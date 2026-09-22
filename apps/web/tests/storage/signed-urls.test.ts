import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "@/lib/storage/provider";
import {
  mintMaterialsSignedUrl,
  pickMaterialsUrl,
  SIGNED_URL_TTL_SECONDS,
  MATERIALS_BUCKET,
} from "@/lib/storage/signed-urls";

// A minimal StorageProvider whose createSignedUrl is the only method under
// test; the rest throw so an accidental call is loud.
function fakeStorage(opts: { signedUrl?: string | null; error?: boolean }) {
  const createSignedUrl = vi.fn(async (bucket: string) => {
    expect(bucket).toBe(MATERIALS_BUCKET);
    return opts.error ? null : (opts.signedUrl ?? null);
  });
  const provider = {
    createSignedUrl,
    upload: vi.fn(),
    remove: vi.fn(),
    publicUrl: vi.fn(),
    ensureBucket: vi.fn(),
  } as unknown as StorageProvider & { createSignedUrl: typeof createSignedUrl };
  return provider;
}

describe("mintMaterialsSignedUrl", () => {
  it("returns the signed URL with a 7-day TTL", async () => {
    const sb = fakeStorage({ signedUrl: "https://signed.example/abc?token=xyz" });
    const url = await mintMaterialsSignedUrl(sb, "teacher/booking/file.pdf");
    expect(url).toBe("https://signed.example/abc?token=xyz");
    expect(sb.createSignedUrl).toHaveBeenCalledWith(
      MATERIALS_BUCKET,
      "teacher/booking/file.pdf",
      SIGNED_URL_TTL_SECONDS,
    );
    expect(SIGNED_URL_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("returns null when the provider reports an error", async () => {
    const sb = fakeStorage({ error: true });
    const url = await mintMaterialsSignedUrl(sb, "missing/path.pdf");
    expect(url).toBeNull();
  });
});

describe("pickMaterialsUrl", () => {
  it("prefers a signed URL minted from storage_path when present", async () => {
    const sb = fakeStorage({ signedUrl: "https://signed/a" });
    const url = await pickMaterialsUrl(sb, {
      storagePath: "t/b/a.pdf",
      linkUrl: null,
    });
    expect(url).toBe("https://signed/a");
  });

  it("falls back to link_url for URL-only attachments", async () => {
    const url = await pickMaterialsUrl(null, {
      storagePath: null,
      linkUrl: "https://drive/external",
    });
    expect(url).toBe("https://drive/external");
  });

  it("returns null when storage_path is null and no linkUrl", async () => {
    const url = await pickMaterialsUrl(null, {
      storagePath: null,
      linkUrl: null,
    });
    expect(url).toBeNull();
  });

  it("falls back to link_url when signing fails (storage outage)", async () => {
    const sb = fakeStorage({ error: true });
    const url = await pickMaterialsUrl(sb, {
      storagePath: "t/b/a.pdf",
      linkUrl: "https://drive/fallback",
    });
    expect(url).toBe("https://drive/fallback");
  });
});
