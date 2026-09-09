import { beforeEach, describe, expect, it, vi } from "vitest";

// The transcription/insights Inngest handlers with real branch logic: the two
// gated pipelines (lesson audio + intro video) that must stay a log-only no-op
// until their feature flag AND a configured vendor are both present, surface an
// "unconfigured" error when the flag is on but a dependency is missing, and only
// then run the real (retryable) step. Plus the two thin wrappers (transcript ->
// insights, google-calendar sync) whose step wiring is now covered too.
//
// Driven through the exported handlers with a fake step runner — the same shape
// as tests/inngest/cron-handlers.test.ts.

vi.mock("@/lib/inngest/client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// --- transcription (lesson audio) seams ---
const transcriptionEnabled = vi.fn(() => false);
vi.mock("@/lib/transcription/config", () => ({ transcriptionEnabled }));
const getTranscriptionProvider = vi.fn(() => null as unknown);
vi.mock("@/lib/transcription/provider", () => ({ getTranscriptionProvider }));
const getLessonAudioStore = vi.fn(() => null as unknown);
vi.mock("@/lib/transcription/lesson-audio-store", () => ({ getLessonAudioStore }));
const processLessonAudioReady = vi.fn(async () => ({ ok: true, transcribed: true }));
vi.mock("@/lib/transcription/pipeline", () => ({ processLessonAudioReady }));

// --- intro-video seams ---
const introVideoCoachEnabled = vi.fn(() => false);
vi.mock("@/lib/intro-video/config", () => ({ introVideoCoachEnabled }));
const processIntroVideoReady = vi.fn(async () => ({ ok: true, analyzed: true }));
vi.mock("@/lib/intro-video/transcribe", () => ({ processIntroVideoReady }));
const loadEntitlements = vi.fn(async () => ({ canUseIntroVideoCoach: true }));
vi.mock("@/lib/subscriptions/service", () => ({ loadEntitlements }));
// The handler wires the pipeline's terminal-outcome callbacks to PostHog and
// drains the posthog-node queue itself (Inngest steps run outside a request
// lifecycle, so nothing else would).
const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics }));

// --- transcript -> insights seams ---
const generateInsights = vi.fn(async () => ({}));
vi.mock("@/lib/lesson-notes/insights", () => ({ generateInsights }));
const generateAndStoreInsights = vi.fn(async () => ({ stored: 3 }));
vi.mock("@/lib/lesson-notes/insights-pipeline", () => ({ generateAndStoreInsights }));

// --- google sync seam ---
const syncAllConnectedTeachers = vi.fn(async () => ({ synced: 2, errors: [] }));
vi.mock("@/lib/calendar/google/sync", () => ({ syncAllConnectedTeachers }));

const { onLessonAudioReadyHandler } = await import("@/lib/inngest/functions/on-lesson-audio-ready");
const { onIntroVideoReadyHandler } = await import("@/lib/inngest/functions/on-intro-video-ready");
const { onLessonTranscriptReadyHandler } =
  await import("@/lib/inngest/functions/on-lesson-transcript-ready");
const { syncGoogleCalendarsHandler } =
  await import("@/lib/inngest/functions/sync-google-calendars");

// Fake step runner that runs each step callback inline (mirrors cron-handlers).
const step = { run: async <T>(_id: string, fn: () => T | Promise<T>) => fn() };

beforeEach(() => {
  vi.clearAllMocks();
  transcriptionEnabled.mockReturnValue(false);
  getTranscriptionProvider.mockReturnValue(null);
  getLessonAudioStore.mockReturnValue(null);
  introVideoCoachEnabled.mockReturnValue(false);
  loadEntitlements.mockResolvedValue({ canUseIntroVideoCoach: true });
});

describe("onLessonAudioReadyHandler — gated", () => {
  const event = {
    data: { bookingId: "b1", audioId: "a1", speaker: "teacher" as const, storageKey: "k1" },
  };

  it("is a log-only no-op while transcription is disabled", async () => {
    const res = await onLessonAudioReadyHandler({ event, step });
    expect(res).toEqual({ ok: true, enabled: false });
    expect(processLessonAudioReady).not.toHaveBeenCalled();
  });

  it("returns unconfigured when the flag is on but the provider is missing", async () => {
    transcriptionEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue(null);
    getLessonAudioStore.mockReturnValue({});
    const res = await onLessonAudioReadyHandler({ event, step });
    expect(res).toEqual({ ok: false, reason: "unconfigured" });
    expect(processLessonAudioReady).not.toHaveBeenCalled();
  });

  it("returns unconfigured when the flag is on but the audio store is missing", async () => {
    transcriptionEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue({});
    getLessonAudioStore.mockReturnValue(null);
    const res = await onLessonAudioReadyHandler({ event, step });
    expect(res).toEqual({ ok: false, reason: "unconfigured" });
    expect(processLessonAudioReady).not.toHaveBeenCalled();
  });

  it("runs the pipeline when enabled and fully configured", async () => {
    transcriptionEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue({ name: "deepgram" });
    getLessonAudioStore.mockReturnValue({ name: "r2" });
    const res = await onLessonAudioReadyHandler({ event, step });
    expect(res).toEqual({ ok: true, transcribed: true });
    expect(processLessonAudioReady).toHaveBeenCalledTimes(1);
    expect(processLessonAudioReady).toHaveBeenCalledWith(
      expect.objectContaining({ provider: { name: "deepgram" }, store: { name: "r2" } }),
      event.data,
    );
  });
});

describe("onIntroVideoReadyHandler — analytics wiring", () => {
  const event = { data: { teacherId: "t1", videoPath: "intro/t1.mp4" } };

  it("flushes analytics even when the pipeline re-throws for the Inngest retry", async () => {
    // The flush sits in a `finally` precisely because the vendor-failure path
    // re-throws: a flush placed after the call would never run for exactly the
    // outcome most worth measuring.
    introVideoCoachEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue({ vendor: "deepgram", transcribe: vi.fn() });
    processIntroVideoReady.mockRejectedValueOnce(new Error("deepgram 503"));
    await expect(onIntroVideoReadyHandler({ event, step })).rejects.toThrow("deepgram 503");
    expect(flushAnalytics).toHaveBeenCalled();
  });
});

describe("onIntroVideoReadyHandler — gated", () => {
  const event = { data: { teacherId: "t1", videoPath: "intro/t1.mp4" } };

  it("is a log-only no-op while the coach is disabled", async () => {
    const res = await onIntroVideoReadyHandler({ event, step });
    expect(res).toEqual({ ok: true, enabled: false });
    expect(processIntroVideoReady).not.toHaveBeenCalled();
  });

  it("returns unconfigured when the flag is on but no provider is configured", async () => {
    introVideoCoachEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue(null);
    const res = await onIntroVideoReadyHandler({ event, step });
    expect(res).toEqual({ ok: false, reason: "unconfigured" });
    expect(processIntroVideoReady).not.toHaveBeenCalled();
  });

  it("runs the pipeline when enabled and configured", async () => {
    introVideoCoachEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue({ name: "deepgram" });
    const res = await onIntroVideoReadyHandler({ event, step });
    expect(res).toEqual({ ok: true, analyzed: true });
    expect(processIntroVideoReady).toHaveBeenCalledTimes(1);
  });

  it("threads the Pro gate through to the pipeline's canUseCoach", async () => {
    introVideoCoachEnabled.mockReturnValue(true);
    getTranscriptionProvider.mockReturnValue({ name: "deepgram" });
    loadEntitlements.mockResolvedValue({ canUseIntroVideoCoach: false });
    await onIntroVideoReadyHandler({ event, step });
    const deps = (processIntroVideoReady.mock.calls[0] as unknown[])[0] as {
      canUseCoach: (id: string) => Promise<boolean>;
    };
    await expect(deps.canUseCoach("t1")).resolves.toBe(false);
    expect(loadEntitlements).toHaveBeenCalledWith("t1");
  });
});

describe("onLessonTranscriptReadyHandler", () => {
  it("runs the insights pipeline for the booking inside a step", async () => {
    const res = await onLessonTranscriptReadyHandler({
      event: { data: { bookingId: "b9" } },
      step,
    });
    expect(res).toEqual({ stored: 3 });
    expect(generateAndStoreInsights).toHaveBeenCalledWith(
      expect.objectContaining({ generate: generateInsights }),
      "b9",
    );
  });
});

describe("syncGoogleCalendarsHandler", () => {
  it("runs the batch sync inside a step and returns its result", async () => {
    const res = await syncGoogleCalendarsHandler({ step });
    expect(res).toEqual({ synced: 2, errors: [] });
    expect(syncAllConnectedTeachers).toHaveBeenCalledTimes(1);
  });
});
