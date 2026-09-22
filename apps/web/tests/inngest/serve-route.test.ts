import { beforeEach, describe, expect, it, vi } from "vitest";

// The /api/inngest serve handler pins `serveOrigin` to the canonical APP_URL in
// production so Inngest doesn't register the per-deploy Vercel preview host
// (which 404s on the next deploy — the root cause of the stuck
// `notification.queued` rows on 2026-05-27). In dev it must stay undefined so
// the inngest-cli auto-discovery still works. This locks that branch + the
// trailing-slash normalization.

const serve = vi.fn(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() }));
vi.mock("inngest/next", () => ({ serve }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { id: "spiralclass" } }));
vi.mock("@/lib/inngest/functions", () => ({ functions: [{ id: "fn-a" }, { id: "fn-b" }] }));

const env = { NODE_ENV: "production", APP_URL: "https://spiralclass.com" };
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

async function importRouteWith(nodeEnv: string, appUrl: string) {
  env.NODE_ENV = nodeEnv;
  env.APP_URL = appUrl;
  serve.mockClear();
  vi.resetModules();
  const mod = await import("@/app/api/inngest/route");
  const config = (serve.mock.calls[0] as unknown[])[0] as {
    serveOrigin?: string;
    functions: unknown[];
  };
  return { mod, config };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/inngest serve handler", () => {
  it("pins serveOrigin to APP_URL in production", async () => {
    const { config } = await importRouteWith("production", "https://spiralclass.com");
    expect(config.serveOrigin).toBe("https://spiralclass.com");
  });

  it("strips a trailing slash from the pinned origin", async () => {
    const { config } = await importRouteWith("production", "https://spiralclass.com/");
    expect(config.serveOrigin).toBe("https://spiralclass.com");
  });

  it("leaves serveOrigin undefined outside production (local dev auto-discovery)", async () => {
    const { config } = await importRouteWith("development", "http://localhost:3000");
    expect(config.serveOrigin).toBeUndefined();
  });

  it("leaves serveOrigin undefined in the test env", async () => {
    const { config } = await importRouteWith("test", "http://localhost:3000");
    expect(config.serveOrigin).toBeUndefined();
  });

  it("registers all functions and exports the three HTTP verbs", async () => {
    const { mod, config } = await importRouteWith("production", "https://spiralclass.com");
    expect(config.functions).toHaveLength(2);
    expect(mod.GET).toBeTypeOf("function");
    expect(mod.POST).toBeTypeOf("function");
    expect(mod.PUT).toBeTypeOf("function");
  });
});
