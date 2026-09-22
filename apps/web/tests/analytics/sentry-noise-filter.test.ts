import { beforeEach, describe, expect, it, vi } from "vitest";

// Coverage for the beforeSend noise filters in instrumentation-client.ts:
// third-party/browser-injected errors that aren't actionable app faults
// should be dropped before reaching Sentry; everything else must pass through.

const initMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  init: initMock,
  captureRouterTransitionStart: vi.fn(),
  replayIntegration: vi.fn((opts) => ({ name: "Replay", options: opts })),
}));

type SentryEvent = Parameters<NonNullable<Parameters<typeof initMock>[0]>>[0];

async function getBeforeSend() {
  vi.resetModules();
  initMock.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://pub@o1.ingest.sentry.io/1");
  await import("@/instrumentation-client");
  const opts = initMock.mock.calls[0]![0] as {
    beforeSend: (event: SentryEvent) => SentryEvent | null;
  };
  return opts.beforeSend;
}

function eventWith(
  value: string,
  opts: { mechanism?: string; transaction?: string; url?: string } = {},
) {
  return {
    exception: {
      values: [
        {
          value,
          mechanism: opts.mechanism ? { type: opts.mechanism } : undefined,
        },
      ],
    },
    transaction: opts.transaction,
    request: opts.url ? { url: opts.url } : undefined,
  } as unknown as SentryEvent;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("Sentry client beforeSend — noise filters", () => {
  it("drops window.__firefox__ ReferenceError noise regardless of route", async () => {
    const beforeSend = await getBeforeSend();
    const event = eventWith("Can't find variable: __firefox__", {
      transaction: "/dashboard/classes",
    });
    expect(beforeSend(event)).toBeNull();
  });

  it("drops window.__firefox__ TypeError noise (reader/quality bridge shapes)", async () => {
    const beforeSend = await getBeforeSend();
    const event = eventWith("undefined is not an object (evaluating 'window.__firefox__.reader')", {
      transaction: "/settings/focus-tags",
    });
    expect(beforeSend(event)).toBeNull();
  });

  it("does not drop unrelated errors", async () => {
    const beforeSend = await getBeforeSend();
    const event = eventWith("TypeError: fetch failed", { transaction: "/dashboard" });
    expect(beforeSend(event)).toBe(event);
  });

  it("still drops the LiveKit unhandled-rejection noise on the /call route", async () => {
    const beforeSend = await getBeforeSend();
    const event = eventWith("(type=error) captured as promise rejection", {
      mechanism: "onunhandledrejection",
      url: "https://app.spiralclass.com/call",
    });
    expect(beforeSend(event)).toBeNull();
  });
});
