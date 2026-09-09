import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cost guard: Sentry Session Replay must stay ERROR-TRIGGERED ONLY. The SDK
// records sessions by default, which silently drained ~82% of the 50/mo
// free-tier replay quota before we pinned it. PostHog already covers product
// flows; Sentry replay is only worth its quota when attached to an error. If a
// future change re-enables all-session replay (replaysSessionSampleRate > 0),
// this test fails loudly instead of the bill doing it.

const initMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  init: initMock,
  captureRouterTransitionStart: vi.fn(),
  replayIntegration: vi.fn((opts) => ({ name: "Replay", options: opts })),
}));

async function importFresh() {
  vi.resetModules();
  return import("@/instrumentation-client");
}

beforeEach(() => {
  initMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Sentry client replay — free-tier cost guard", () => {
  it("records replays ONLY on error (0% ordinary sessions, 100% error sessions)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://pub@o1.ingest.sentry.io/1");
    await importFresh();
    expect(initMock).toHaveBeenCalledTimes(1);
    const opts = initMock.mock.calls[0]![0] as {
      replaysSessionSampleRate: number;
      replaysOnErrorSampleRate: number;
    };
    expect(opts.replaysSessionSampleRate).toBe(0);
    expect(opts.replaysOnErrorSampleRate).toBe(1.0);
  });

  it("masks inputs, text, and media on replays (payments app — no PII in a replay)", async () => {
    const { replayIntegration } = await import("@sentry/nextjs");
    const replayMock = replayIntegration as unknown as ReturnType<typeof vi.fn>;
    replayMock.mockClear();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://pub@o1.ingest.sentry.io/1");
    await importFresh();
    expect(replayMock).toHaveBeenCalledWith({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    });
  });

  it("no-ops entirely without a DSN", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    await importFresh();
    expect(initMock).not.toHaveBeenCalled();
  });
});
