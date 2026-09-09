import { describe, expect, it } from "vitest";

// /api/health/live is what Fly's [[http_service.checks]] hits every 15s on
// both prod and preview (fly.production.toml / fly.preview.toml). It must
// NOT touch Postgres — a DB query on a 15s cadence never lets Neon's ~5min
// idle-suspend window elapse, which is what kept both projects' primary
// branch active 100% of the time (diagnosed 2026-08-07). Real DB-readiness
// stays on the sibling /api/health route, polled far less often by external
// uptime monitors and synthetic.yml.

const { GET } = await import("@/app/api/health/live/route");

describe("GET /api/health/live", () => {
  it("reports ok without querying the database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });
});
