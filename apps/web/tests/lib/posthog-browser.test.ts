import { beforeEach, describe, expect, it, vi } from "vitest";

// The web PostHog bootstrap must stamp every event with the deployment
// environment (a super-property) so preview deploys + their test traffic can be
// filtered out of production insights — web and mobile share ONE PostHog
// project, split by this property. It uses the same resolver as Sentry
// (sentry-environment) so the two always agree on which environment a
// deployment is.

const posthogMock = vi.hoisted(() => ({ init: vi.fn(), register: vi.fn() }));
vi.mock("posthog-js", () => ({ __esModule: true, default: posthogMock }));

const envMock = vi.hoisted(() => ({ current: "production" as string }));
vi.mock("@/lib/sentry-environment", () => ({ sentryEnvironment: () => envMock.current }));

beforeEach(() => {
  vi.resetModules(); // reset posthog-browser's `initialized` singleton between tests
  vi.clearAllMocks();
});

const OPTS = { key: "phc_test", apiHost: "/ingest", uiHost: "https://us.posthog.com" };

// Pulls the `before_send` hook posthog-browser passes into posthog.init(). The
// environment tag is applied there (not a post-init register) so the first
// auto-captured $pageview — emitted synchronously during init() — is tagged too.
function beforeSend(): (event: unknown) => unknown {
  const opts = posthogMock.init.mock.calls[0][1] as { before_send: (e: unknown) => unknown };
  return opts.before_send;
}

describe("initBrowserAnalytics", () => {
  it("stamps the deployment environment on every event via before_send", async () => {
    envMock.current = "preview";
    const { initBrowserAnalytics } = await import("@/lib/analytics/posthog-browser");
    initBrowserAnalytics(OPTS);
    expect(posthogMock.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "/ingest" }),
    );
    expect(beforeSend()({ properties: {} })).toEqual({
      properties: { environment: "preview", platform: "web" },
    });
  });

  it("tags production events with the production environment", async () => {
    envMock.current = "production";
    const { initBrowserAnalytics } = await import("@/lib/analytics/posthog-browser");
    initBrowserAnalytics(OPTS);
    expect(beforeSend()({ properties: {} })).toEqual({
      properties: { environment: "production", platform: "web" },
    });
  });

  it("does not clobber an environment already set on the event", async () => {
    envMock.current = "production";
    const { initBrowserAnalytics } = await import("@/lib/analytics/posthog-browser");
    initBrowserAnalytics(OPTS);
    expect(beforeSend()({ properties: { environment: "preview" } })).toEqual({
      properties: { environment: "preview", platform: "web" },
    });
  });

  it("stamps platform=web on every event, regardless of the visitor's device (phone browser is still the web app)", async () => {
    envMock.current = "production";
    const { initBrowserAnalytics } = await import("@/lib/analytics/posthog-browser");
    initBrowserAnalytics(OPTS);
    expect(beforeSend()({ properties: {} })).toEqual(
      expect.objectContaining({ properties: expect.objectContaining({ platform: "web" }) }),
    );
  });

  it("does not clobber a platform already set on the event", async () => {
    envMock.current = "production";
    const { initBrowserAnalytics } = await import("@/lib/analytics/posthog-browser");
    initBrowserAnalytics(OPTS);
    expect(beforeSend()({ properties: { platform: "other" } })).toEqual({
      properties: { platform: "other", environment: "production" },
    });
  });
});
