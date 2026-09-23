import { describe, expect, it } from "vitest";

// /api/health/live is what the external uptime monitor hits about once a
// minute (and what Fly's health checks hit every 15s until Fly was retired). It must
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
