import { beforeEach, describe, expect, it, vi } from "vitest";

// Orchestration for material podcast generation: the Pro gate + monthly cap +
// creds checks, idempotency, and the enqueue. Everything external is mocked so
// the branching is observable without a DB or vendors.

const h = vi.hoisted(() => {
  const gateProFeature = vi.fn(async () => ({ ok: true as boolean, limit: {} as unknown }));
  const creds = { hasAnthropicCreds: vi.fn(() => true), podcastsEnabled: vi.fn(() => true) };
  const send = vi.fn(async () => {});
  const trackServerEvent = vi.fn();
  const db = {
    teacher: { findUnique: vi.fn(async () => ({ targetLanguage: "fr" })) },
    classContentGeneration: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
    libraryMaterial: { findFirst: vi.fn() },
    materialPodcast: {
      upsert: vi.fn(async () => ({})),
      findFirst: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return { gateProFeature, creds, send, trackServerEvent, db };
});
const { gateProFeature, creds, send, db } = h;

vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...a: unknown[]) => h.gateProFeature(...(a as [])),
  upgradeNudge: () => "upgrade-nudge",
}));
vi.mock("@/lib/env", () => h.creds);
// Phase 2a: the producer enqueues through the provider-agnostic seam.
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: (...a: unknown[]) => h.send(...(a as [])) }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...a: unknown[]) => h.trackServerEvent(...(a as [])),
}));
vi.mock("@/lib/focus-tags", () => ({
  resolveFocusTagsWithCategory: vi.fn(async () => [
    { id: "t1", label: "verbs", categoryCode: "grammar" },
  ]),
}));
vi.mock("@spiralclass/shared", async (importOriginal) => ({
  languageName: (c: string) => (c === "fr" ? "French" : c),
  // REAL, not a stub: the answer-key strip below is the assertion, and a
  // stubbed pass-through would make it pass while the leak was still there.
  stripAnswerKeyMarkdown: ((await importOriginal()) as typeof import("@spiralclass/shared"))
    .stripAnswerKeyMarkdown,
}));
vi.mock("@/lib/storage/material-podcast", () => ({
  mintMaterialPodcastSignedUrl: vi.fn(async () => "https://signed/podcast.mp3"),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.db }));

import {
  estimatePodcastDurationSec,
  getMaterialPodcast,
  preparePodcastJob,
  requestMaterialPodcast,
} from "@/lib/materials/podcast";

const input = { teacherId: "teacher-1", materialId: "mat-1", locale: "en" as const };

beforeEach(() => {
  vi.clearAllMocks();
  gateProFeature.mockResolvedValue({ ok: true, limit: {} });
  creds.hasAnthropicCreds.mockReturnValue(true);
  creds.podcastsEnabled.mockReturnValue(true);
  db.classContentGeneration.count.mockResolvedValue(0);
  db.libraryMaterial.findFirst.mockResolvedValue({
    id: "mat-1",
    body: "Some content",
    podcast: null,
  });
});

describe("requestMaterialPodcast", () => {
  it("blocks non-Pro teachers", async () => {
    gateProFeature.mockResolvedValue({ ok: false, limit: {} });
    const res = await requestMaterialPodcast(input);
    expect(res).toEqual({ ok: false, code: "not-pro", message: "upgrade-nudge" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports not-configured when a vendor key is missing", async () => {
    creds.podcastsEnabled.mockReturnValue(false);
    const res = await requestMaterialPodcast(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not-configured");
    expect(send).not.toHaveBeenCalled();
  });

  it("enforces the shared monthly AI cap", async () => {
    db.classContentGeneration.count.mockResolvedValue(100);
    const res = await requestMaterialPodcast(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("cap");
  });

  it("404s a material that isn't the teacher's", async () => {
    db.libraryMaterial.findFirst.mockResolvedValue(null);
    const res = await requestMaterialPodcast(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not-found");
  });

  it("rejects a material with no body", async () => {
    db.libraryMaterial.findFirst.mockResolvedValue({ id: "mat-1", body: "   ", podcast: null });
    const res = await requestMaterialPodcast(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid");
  });

  it("is idempotent while a podcast is already generating", async () => {
    db.libraryMaterial.findFirst.mockResolvedValue({
      id: "mat-1",
      body: "x",
      podcast: { status: "pending" },
    });
    const res = await requestMaterialPodcast(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("already-pending");
    expect(send).not.toHaveBeenCalled();
    expect(db.materialPodcast.upsert).not.toHaveBeenCalled();
  });

  it("upserts pending and emits the Inngest event on the happy path", async () => {
    const res = await requestMaterialPodcast(input);
    expect(res).toEqual({ ok: true });
    expect(db.materialPodcast.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { materialId: "mat-1" } }),
    );
    expect(send).toHaveBeenCalledWith(
      "material.podcast.requested",
      expect.objectContaining({ materialId: "mat-1" }),
    );
    // Enqueue does NOT burn quota — only a successful render does.
    expect(db.classContentGeneration.create).not.toHaveBeenCalled();
  });
});

describe("getMaterialPodcast", () => {
  it("mints a signed URL only when ready", async () => {
    db.materialPodcast.findFirst.mockResolvedValue({
      status: "ready",
      storagePath: "t/m/1.mp3",
      durationSec: 200,
      generatedAt: new Date(),
      error: null,
    });
    const view = await getMaterialPodcast(input);
    expect(view?.status).toBe("ready");
    expect(view?.url).toBe("https://signed/podcast.mp3");
  });

  it("returns no url while pending", async () => {
    db.materialPodcast.findFirst.mockResolvedValue({
      status: "pending",
      storagePath: null,
      durationSec: null,
      generatedAt: null,
      error: null,
    });
    const view = await getMaterialPodcast(input);
    expect(view?.status).toBe("pending");
    expect(view?.url).toBeNull();
  });

  it("returns null when no podcast row exists", async () => {
    db.materialPodcast.findFirst.mockResolvedValue(null);
    expect(await getMaterialPodcast(input)).toBeNull();
  });
});

describe("estimatePodcastDurationSec", () => {
  it("estimates ~150 wpm", () => {
    const script = Array.from({ length: 150 }, () => "word").join(" ");
    expect(estimatePodcastDurationSec(script)).toBe(60);
  });
  it("never returns zero for a tiny script", () => {
    expect(estimatePodcastDurationSec("hi")).toBeGreaterThanOrEqual(1);
  });
});

// A podcast is a student-facing artifact (getStudentLibraryView mints a
// playback URL for it), so the narrator must be handed the STUDENT copy of the
// body — otherwise every text-side answer-key filter is undone in one listen.
// The cut is made on the PROMPT INPUT, so the model is never told the answers
// and cannot allude to them either.
describe("preparePodcastJob answer-key filtering", () => {
  const ANSWERED = [
    "> [!exercise]",
    "> Complete the gap: She (go) to school.",
    "",
    "> [!answer]",
    "> goes",
  ].join("\n");

  const jobInput = {
    teacherId: "teacher-1",
    materialId: "mat-1",
    targetDurationMin: 4,
    locale: "en" as const,
  };

  const pendingMaterial = (body: string) => ({
    body,
    levelId: "a1",
    level: { label: "A1" },
    focusTags: [],
    podcast: { status: "pending" },
  });

  it("never puts answer-key text in the script prompt", async () => {
    db.libraryMaterial.findFirst.mockResolvedValue(pendingMaterial(ANSWERED));
    const res = await preparePodcastJob(jobInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.promptInput.body).toContain("Complete the gap");
    expect(res.promptInput.body).not.toContain("[!answer]");
    expect(res.promptInput.body).not.toContain("goes");
  });

  it("passes a body with no answer key through unchanged", async () => {
    const body = "# Lesson\n\n> [!tip]\n> Read it aloud.";
    db.libraryMaterial.findFirst.mockResolvedValue(pendingMaterial(body));
    const res = await preparePodcastJob(jobInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.promptInput.body).toBe(body);
  });

  it("terminally skips a material whose whole body was an answer key", async () => {
    // Nothing left to narrate — the same terminal `invalid` an empty body
    // already gets, rather than synthesizing a podcast of silence.
    db.libraryMaterial.findFirst.mockResolvedValue(pendingMaterial("> [!answer]\n> 42"));
    const res = await preparePodcastJob(jobInput);
    expect(res).toEqual({ ok: false, terminal: true, reason: "invalid" });
  });
});
