import { beforeEach, describe, expect, it, vi } from "vitest";

// The podcast Inngest job: prepare → script → synth+upload → finalize, with
// each stage guarded so a failure marks the row failed and a retry-after-success
// is a no-op. createFunction is mocked to hand back the raw handler so we can
// drive it with a fake step runner.

const h = vi.hoisted(() => {
  const store = { handler: null as ((ctx: unknown) => Promise<unknown>) | null };
  const podcast = {
    preparePodcastJob: vi.fn(),
    completePodcast: vi.fn(async () => ({ burned: true })),
    failPodcast: vi.fn(async () => {}),
    estimatePodcastDurationSec: vi.fn(() => 120),
  };
  const generatePodcastScript = vi.fn();
  const synthesizePodcast = vi.fn();
  const storage = {
    uploadMaterialPodcast: vi.fn(async () => ({ storagePath: "t/m/1.mp3" })),
    headMaterialPodcastObject: vi.fn(async (): Promise<number | null> => 4096),
  };
  return { store, podcast, generatePodcastScript, synthesizePodcast, storage };
});
const { podcast, generatePodcastScript, synthesizePodcast, storage } = h;

vi.mock("@/lib/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, fn: (ctx: unknown) => Promise<unknown>) => (
      (h.store.handler = fn),
      {}
    ),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/materials/podcast", () => h.podcast);
vi.mock("@/lib/ai/anthropic", () => ({
  generatePodcastScript: (...a: unknown[]) => h.generatePodcastScript(...(a as [])),
}));
vi.mock("@/lib/ai/tts", () => ({
  synthesizePodcast: (...a: unknown[]) => h.synthesizePodcast(...(a as [])),
}));
vi.mock("@/lib/storage/material-podcast", () => h.storage);

import "@/lib/inngest/functions/on-material-podcast-requested";

const step = { run: async (_name: string, fn: () => unknown) => fn() };
const event = {
  data: { teacherId: "t1", materialId: "m1", language: null, targetDurationMin: 4, locale: "en" },
  ts: 1_700_000,
};
const promptInput = { body: "x", locale: "en", targetDurationMin: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  podcast.preparePodcastJob.mockResolvedValue({ ok: true, promptInput });
  generatePodcastScript.mockResolvedValue({ ok: true, script: "Welcome to the show." });
  synthesizePodcast.mockResolvedValue({
    ok: true,
    audio: new Uint8Array([1, 2, 3]),
    voiceId: "v1",
  });
  storage.uploadMaterialPodcast.mockResolvedValue({ storagePath: "t/m/1.mp3" });
  storage.headMaterialPodcastObject.mockResolvedValue(4096);
});

describe("on-material-podcast-requested", () => {
  it("runs the full pipeline and finalizes ready", async () => {
    const res = (await h.store.handler!({ event, step })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(generatePodcastScript).toHaveBeenCalledWith(promptInput);
    expect(synthesizePodcast).toHaveBeenCalledWith("Welcome to the show.", {
      language: null,
      locale: "en",
    });
    expect(storage.uploadMaterialPodcast).toHaveBeenCalledWith(
      "t1",
      "m1",
      expect.any(Uint8Array),
      1_700_000,
    );
    expect(podcast.completePodcast).toHaveBeenCalledWith(
      expect.objectContaining({ materialId: "m1", storagePath: "t/m/1.mp3", voice: "v1" }),
    );
    expect(podcast.failPodcast).not.toHaveBeenCalled();
  });

  it("is a no-op when the row is no longer pending (retry after success)", async () => {
    podcast.preparePodcastJob.mockResolvedValue({
      ok: false,
      terminal: true,
      reason: "not-pending",
    });
    await h.store.handler!({ event, step });
    expect(generatePodcastScript).not.toHaveBeenCalled();
    expect(podcast.completePodcast).not.toHaveBeenCalled();
    expect(podcast.failPodcast).not.toHaveBeenCalled();
  });

  it("marks failed when the cap was crossed by job time", async () => {
    podcast.preparePodcastJob.mockResolvedValue({ ok: false, terminal: true, reason: "cap" });
    await h.store.handler!({ event, step });
    expect(podcast.failPodcast).toHaveBeenCalledWith(expect.objectContaining({ reason: "cap" }));
    expect(podcast.completePodcast).not.toHaveBeenCalled();
  });

  it("marks failed and burns nothing when synthesis fails", async () => {
    synthesizePodcast.mockResolvedValue({ ok: false, reason: "error" });
    await h.store.handler!({ event, step });
    expect(podcast.failPodcast).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "synth:error" }),
    );
    expect(podcast.completePodcast).not.toHaveBeenCalled();
  });

  it("marks failed when the uploaded object doesn't land", async () => {
    storage.headMaterialPodcastObject.mockResolvedValue(null);
    await h.store.handler!({ event, step });
    expect(podcast.failPodcast).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "upload:not-landed" }),
    );
  });
});
