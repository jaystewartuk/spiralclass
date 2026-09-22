import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createR2Provider } from "@/lib/storage/provider";

// createR2Provider() is the Cloudflare R2 StorageProvider — an S3-compatible
// client built on the hand-rolled SigV4 presigner (lib/aws/sigv4.ts), pinned
// against AWS's published vector in tests/aws/sigv4.test.ts. These tests stub
// fetch and assert the provider builds valid presigned requests and maps
// HTTP outcomes onto the StorageProvider contract correctly.

const ENV = {
  TEACHER_PHOTOS_R2_BUCKET: "teacher-photos-bucket",
  TEACHER_PHOTOS_R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  TEACHER_PHOTOS_R2_ACCESS_KEY: "AKIAEXAMPLE",
  TEACHER_PHOTOS_R2_SECRET: "secretexample",
  TEACHER_PHOTOS_R2_REGION: "auto",
  NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL: "https://pub-abc123.r2.dev",
  CLASS_MATERIALS_R2_BUCKET: "class-materials-bucket",
  CLASS_MATERIALS_R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  CLASS_MATERIALS_R2_ACCESS_KEY: "AKIAEXAMPLE2",
  CLASS_MATERIALS_R2_SECRET: "secretexample2",
  CLASS_MATERIALS_R2_REGION: "auto",
};

function stubEnv() {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // r2BucketConfig reads process.env at call time. CI runs this suite inside
  // the Vercel build, where the REAL TEACHER_PHOTOS_R2_* / CLASS_MATERIALS_R2_*
  // vars are injected — so `vi.unstubAllEnvs()` alone leaves this suite reading
  // production config (and the "unconfigured" tests below would hit the real
  // network with real credentials). Force every R2 key empty by default so the
  // suite is hermetic; each configured test opts back in via stubEnv().
  for (const k of Object.keys(ENV)) vi.stubEnv(k, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createR2Provider: unconfigured bucket", () => {
  beforeEach(() => {
    // Env is already cleared above, so config resolves null and fetch is never
    // reached. This guard makes that a hard invariant: if the config path ever
    // regresses, the test fails loudly here instead of silently calling prod R2.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch must not be called for an unconfigured bucket");
      }),
    );
  });

  it("upload returns an error without configured env vars", async () => {
    const provider = createR2Provider();
    const result = await provider.upload("teacher-photos", "abc", new Uint8Array([1]));
    expect(result.error).toEqual({ message: "r2-not-configured" });
  });

  it("createSignedUrl returns null without configured env vars", async () => {
    const provider = createR2Provider();
    const url = await provider.createSignedUrl("class-materials", "t/b/f.pdf", 3600);
    expect(url).toBeNull();
  });

  it("publicUrl returns null for an unknown bucket", () => {
    const provider = createR2Provider();
    expect(provider.publicUrl("some-other-bucket", "abc")).toBeNull();
  });
});

describe("createR2Provider: upload", () => {
  it("PUTs to a presigned R2 URL scoped to the bucket + path", async () => {
    stubEnv();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toContain("abc123.r2.cloudflarestorage.com");
      expect(url).toContain("/teacher-photos-bucket/teacher-1");
      expect(url).toContain("X-Amz-Signature=");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createR2Provider();
    const result = await provider.upload("teacher-photos", "teacher-1", new Uint8Array([1, 2, 3]), {
      contentType: "image/jpeg",
      upsert: true,
    });

    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" } });
  });

  it("checks for an existing object first when upsert is false", async () => {
    stubEnv();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createR2Provider();
    const result = await provider.upload("class-materials", "t/b/file.pdf", new Uint8Array([1]), {
      upsert: false,
    });

    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT" });
  });

  it("errors on collision when upsert is false and the object already exists", async () => {
    stubEnv();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      throw new Error("PUT should not be called on collision");
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createR2Provider();
    const result = await provider.upload("class-materials", "t/b/file.pdf", new Uint8Array([1]), {
      upsert: false,
    });

    expect(result.error).toEqual({ message: "object already exists" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("includes a Cache-Control header only when the caller opts in", async () => {
    stubEnv();
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createR2Provider();

    await provider.upload("teacher-photos", "teacher-1", new Uint8Array([1]), {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    });

    fetchMock.mockClear();
    await provider.upload("teacher-photos", "teacher-1", new Uint8Array([1]), {
      contentType: "image/jpeg",
      upsert: true,
    });
    const [, initWithoutCacheControl] = fetchMock.mock.calls[0];
    expect(
      (initWithoutCacheControl?.headers as Record<string, string> | undefined)?.["Cache-Control"],
    ).toBeUndefined();
  });

  it("surfaces a non-OK PUT response as an error", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const provider = createR2Provider();
    const result = await provider.upload("teacher-photos", "teacher-1", new Uint8Array([1]), {
      upsert: true,
    });

    expect(result.error).toEqual({ message: "r2-put-http-500" });
  });
});

describe("createR2Provider: remove", () => {
  it("DELETEs each path and reports no error on success", async () => {
    stubEnv();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createR2Provider();
    const result = await provider.remove("class-materials", ["t/b/a.pdf", "t/b/b.pdf"]);

    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a 404 as success (already gone)", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const provider = createR2Provider();
    const result = await provider.remove("class-materials", ["missing.pdf"]);
    expect(result.error).toBeNull();
  });

  it("collects errors for failed deletes", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    const provider = createR2Provider();
    const result = await provider.remove("class-materials", ["t/b/a.pdf"]);
    expect(result.error).toEqual({ message: "r2-delete-http-500" });
  });
});

describe("createR2Provider: createSignedUrl", () => {
  it("mints a presigned GET URL with the requested TTL", async () => {
    stubEnv();
    const provider = createR2Provider();
    const url = await provider.createSignedUrl("class-materials", "t/b/file.pdf", 7 * 24 * 60 * 60);

    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.host).toBe("abc123.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/class-materials-bucket/t/b/file.pdf");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(7 * 24 * 60 * 60));
  });
});

describe("createR2Provider: publicUrl", () => {
  it("builds a stable URL from the configured public base, with no network call", () => {
    stubEnv();
    const provider = createR2Provider();
    const url = provider.publicUrl("teacher-photos", "teacher-1", 42);
    expect(url).toBe("https://pub-abc123.r2.dev/teacher-1?v=42");
  });

  it("returns null for a null path", () => {
    stubEnv();
    const provider = createR2Provider();
    expect(provider.publicUrl("teacher-photos", null)).toBeNull();
  });

  it("returns null when no public URL is configured (private bucket)", () => {
    stubEnv();
    const provider = createR2Provider();
    expect(provider.publicUrl("class-materials", "t/b/file.pdf")).toBeNull();
  });
});

describe("createR2Provider: ensureBucket", () => {
  it("is a no-op that resolves without error (R2 buckets are provisioned out-of-band)", async () => {
    const provider = createR2Provider();
    await expect(
      provider.ensureBucket("teacher-photos", { public: true }),
    ).resolves.toBeUndefined();
  });
});
