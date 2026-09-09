import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteMaterialPodcastObject,
  headMaterialPodcastObject,
  mintMaterialPodcastSignedUrl,
  uploadMaterialPodcast,
} from "@/lib/storage/material-podcast";

// R2 storage for generated podcast audio. Set fake R2 config so the SigV4
// presign (pure URL build, no network) runs; stub fetch for the PUT/HEAD/DELETE.

const CFG = {
  MATERIAL_PODCASTS_R2_BUCKET: "material-podcasts",
  MATERIAL_PODCASTS_R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  MATERIAL_PODCASTS_R2_ACCESS_KEY: "AKIATEST",
  MATERIAL_PODCASTS_R2_SECRET: "secretkey",
  MATERIAL_PODCASTS_R2_REGION: "auto",
};

function setConfig() {
  for (const [k, v] of Object.entries(CFG)) process.env[k] = v;
}
function clearConfig() {
  for (const k of Object.keys(CFG)) delete process.env[k];
}

describe("material-podcast R2 store", () => {
  beforeEach(() => {
    setConfig();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearConfig();
    vi.clearAllMocks();
  });

  it("uploads under a teacher/material-scoped path and PUTs the bytes", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 } as Response);
    const res = await uploadMaterialPodcast(
      "teacher-1",
      "mat-1",
      new Uint8Array([1, 2]),
      1_700_000,
    );
    expect("storagePath" in res && res.storagePath).toBe("teacher-1/mat-1/1700000.mp3");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("audio/mpeg");
    expect(url).toContain("/material-podcasts/teacher-1/mat-1/1700000.mp3");
  });

  it("returns an error on a non-2xx upload", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 } as Response);
    const res = await uploadMaterialPodcast("t", "m", new Uint8Array([1]), 1);
    expect("error" in res && res.error).toBe("r2-put-http-500");
  });

  it("degrades to r2-not-configured when env is missing", async () => {
    clearConfig();
    const res = await uploadMaterialPodcast("t", "m", new Uint8Array([1]), 1);
    expect("error" in res && res.error).toBe("r2-not-configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the object size on HEAD", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "4096" }),
    } as Response);
    expect(await headMaterialPodcastObject("t/m/1.mp3")).toBe(4096);
  });

  it("returns null from HEAD when the object is missing", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false } as Response);
    expect(await headMaterialPodcastObject("t/m/1.mp3")).toBeNull();
  });

  it("mints a signed GET URL to the object (no network)", async () => {
    const url = await mintMaterialPodcastSignedUrl("teacher-1/mat-1/1.mp3");
    expect(url).toContain("/material-podcasts/teacher-1/mat-1/1.mp3");
    expect(url).toMatch(/X-Amz-Signature=/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a 404 delete as success (idempotent)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await deleteMaterialPodcastObject("t/m/1.mp3")).toBe(true);
  });
});
