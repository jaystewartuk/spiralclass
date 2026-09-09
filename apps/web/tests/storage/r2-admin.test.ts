import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// r2-admin.ts is a server module (`import "server-only"`); neutralize the guard
// so it can be unit-tested under the node runner (same pattern as the captions
// tests).
vi.mock("server-only", () => ({}));

import {
  parseListResult,
  listBrowsableBuckets,
  listObjects,
  signObjectUrl,
  BucketUnavailableError,
} from "@/lib/storage/r2-admin";

// Every env var the three allowlisted buckets read. Forced empty by default so
// the suite is hermetic even when CI injects real R2 config into the build
// (same guard as tests/storage/r2-provider.test.ts).
const PREFIXES = ["CLASS_MATERIALS", "TEACHER_PHOTOS", "CHAT_AUDIO"] as const;
const ALL_KEYS = PREFIXES.flatMap((p) => [
  `${p}_R2_BUCKET`,
  `${p}_R2_ENDPOINT`,
  `${p}_R2_REGION`,
  `${p}_R2_ACCESS_KEY`,
  `${p}_R2_SECRET`,
]);

function configure(prefix: string, bucket: string) {
  vi.stubEnv(`${prefix}_R2_BUCKET`, bucket);
  vi.stubEnv(`${prefix}_R2_ENDPOINT`, "https://acc.r2.cloudflarestorage.com");
  vi.stubEnv(`${prefix}_R2_REGION`, "auto");
  vi.stubEnv(`${prefix}_R2_ACCESS_KEY`, "AKIAEXAMPLE");
  vi.stubEnv(`${prefix}_R2_SECRET`, "secretexample");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const k of ALL_KEYS) vi.stubEnv(k, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>class-materials-bucket</Name>
  <Prefix>t1/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>TOKEN123</NextContinuationToken>
  <Contents>
    <Key>t1/b1/handout &amp; notes.pdf</Key>
    <LastModified>2026-07-01T10:00:00.000Z</LastModified>
    <Size>2048</Size>
    <ETag>"abc"</ETag>
  </Contents>
  <Contents>
    <Key>t1/b1/audio.ogg</Key>
    <LastModified>2026-07-02T11:00:00.000Z</LastModified>
    <Size>500</Size>
  </Contents>
  <CommonPrefixes><Prefix>t1/b1/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>t1/b2/</Prefix></CommonPrefixes>
</ListBucketResult>`;

describe("parseListResult", () => {
  it("extracts prefixes, objects, and the continuation token", () => {
    const r = parseListResult(SAMPLE_XML);
    expect(r.prefixes).toEqual(["t1/b1/", "t1/b2/"]);
    expect(r.objects).toEqual([
      { key: "t1/b1/handout & notes.pdf", size: 2048, lastModified: "2026-07-01T10:00:00.000Z" },
      { key: "t1/b1/audio.ogg", size: 500, lastModified: "2026-07-02T11:00:00.000Z" },
    ]);
    expect(r.nextToken).toBe("TOKEN123");
  });

  it("returns nextToken=null when the listing is not truncated", () => {
    const xml = SAMPLE_XML.replace(
      "<IsTruncated>true</IsTruncated>",
      "<IsTruncated>false</IsTruncated>",
    );
    expect(parseListResult(xml).nextToken).toBeNull();
  });

  it("handles an empty bucket", () => {
    const xml = `<ListBucketResult><Name>b</Name><IsTruncated>false</IsTruncated></ListBucketResult>`;
    expect(parseListResult(xml)).toEqual({ prefixes: [], objects: [], nextToken: null });
  });
});

describe("listBrowsableBuckets", () => {
  it("returns nothing when no bucket is configured (dark by default)", () => {
    expect(listBrowsableBuckets()).toEqual([]);
  });

  it("returns only configured buckets and never leaks the env prefix", () => {
    configure("CLASS_MATERIALS", "class-materials-bucket");
    configure("TEACHER_PHOTOS", "teacher-photos-bucket");
    // CHAT_AUDIO intentionally left unconfigured.
    const buckets = listBrowsableBuckets();
    expect(buckets.map((b) => b.key).sort()).toEqual(["class-materials", "teacher-photos"]);
    for (const b of buckets) {
      expect(b).not.toHaveProperty("envPrefix");
      expect(b).toHaveProperty("sensitivity");
    }
  });

  it("only ever exposes this product's own content buckets (allowlist)", () => {
    for (const p of PREFIXES) configure(p, `${p.toLowerCase()}-bucket`);
    const keys = listBrowsableBuckets().map((b) => b.key);
    // Backups, infra state, and other products are not in the registry and can
    // never appear here, however the account's buckets are named.
    expect(keys.every((k) => ["class-materials", "teacher-photos", "chat-audio"].includes(k))).toBe(
      true,
    );
    expect(keys).not.toContain("agendaprofe-backups");
    expect(keys).not.toContain("agendaprofe-tofu-state");
  });
});

describe("listObjects", () => {
  // Capture the request URL from within the fetch stub so the assertion reads a
  // used binding (no unused-param lint noise).
  function stubFetch(): { url: () => string } {
    let captured = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        captured = String(input);
        return new Response(SAMPLE_XML, { status: 200 });
      }),
    );
    return { url: () => captured };
  }

  it("signs a ListObjectsV2 request against the real bucket and parses the result", async () => {
    configure("CLASS_MATERIALS", "class-materials-bucket");
    const req = stubFetch();

    const listing = await listObjects("class-materials", "t1/");

    expect(listing.prefixes).toEqual(["t1/b1/", "t1/b2/"]);
    expect(listing.objects).toHaveLength(2);
    expect(listing.nextToken).toBe("TOKEN123");

    const url = new URL(req.url());
    expect(url.pathname).toBe("/class-materials-bucket");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("delimiter")).toBe("/");
    expect(url.searchParams.get("prefix")).toBe("t1/");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forwards a continuation token when paginating", async () => {
    configure("CLASS_MATERIALS", "class-materials-bucket");
    const req = stubFetch();

    await listObjects("class-materials", "t1/", "TOKEN123");
    const url = new URL(req.url());
    expect(url.searchParams.get("continuation-token")).toBe("TOKEN123");
  });

  it("throws BucketUnavailableError for a bucket not in the allowlist", async () => {
    configure("CLASS_MATERIALS", "class-materials-bucket");
    await expect(listObjects("agendaprofe-backups", "")).rejects.toBeInstanceOf(
      BucketUnavailableError,
    );
  });

  it("throws BucketUnavailableError for an allowlisted-but-unconfigured bucket", async () => {
    // CHAT_AUDIO is a valid registry key but has no credentials in this env.
    await expect(listObjects("chat-audio", "")).rejects.toBeInstanceOf(BucketUnavailableError);
  });
});

describe("signObjectUrl", () => {
  it("mints a signed GET URL for an object in a configured bucket", async () => {
    configure("CLASS_MATERIALS", "class-materials-bucket");
    const url = new URL(await signObjectUrl("class-materials", "t1/b1/handout.pdf"));
    expect(url.host).toBe("acc.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/class-materials-bucket/t1/b1/handout.pdf");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("throws BucketUnavailableError for an unknown bucket", async () => {
    await expect(signObjectUrl("nope", "k")).rejects.toBeInstanceOf(BucketUnavailableError);
  });
});
