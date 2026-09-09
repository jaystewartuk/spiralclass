import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /api/health is the probe Fly's health check and any external uptime monitor
// hit. Two behaviours matter and pull in opposite directions:
//
//   * It must fail (503) whenever Postgres is unreachable — Fly decides
//     machine health from this, so softening the status would hide a real
//     outage.
//   * It must NOT page for the cold-start window. `auto_stop_machines` means
//     machines boot on demand and the first Neon connection can exceed this
//     route's 5s DB timeout; fly.production.toml's 30s grace_period already
//     tolerates exactly that. Reporting each one produced SPIRALCLASS-21 —
//     126 production events, none an incident — which is precisely the kind
//     of permanently-red issue a genuine DB failure then hides behind.

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: queryRaw } }));

const logError = vi.fn();
const logWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: () => ({ error: logError, warn: logWarn, info: vi.fn(), debug: vi.fn() }),
}));

const { GET } = await import("@/app/api/health/route");

const realUptime = process.uptime;

function setUptime(seconds: number) {
  process.uptime = () => seconds;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  setUptime(3600);
});

afterEach(() => {
  process.uptime = realUptime;
});

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok", db: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"));
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: "degraded", db: "fail" });
  });

  it("pages via log.error for a failure on a long-running process", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"));
    await GET();
    // logger.error is what forwards to Sentry — this is the alerting path.
    expect(logError).toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("does not page for a failure inside the boot warmup window", async () => {
    setUptime(12); // ~13s after boot, which is when SPIRALCLASS-21 fired
    queryRaw.mockRejectedValue(new Error("DB health check timed out after 5000ms"));
    await GET();

    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it("still returns 503 during warmup, so Fly still decides machine health", async () => {
    // Suppressing the alert must not soften the verdict — the probe failing is
    // how a machine that never warms up gets replaced.
    setUptime(12);
    queryRaw.mockRejectedValue(new Error("DB health check timed out after 5000ms"));
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("resumes paging once past the warmup window", async () => {
    // A DB failure that outlasts the grace period is a real incident again.
    setUptime(60);
    queryRaw.mockRejectedValue(new Error("connection refused"));
    await GET();
    expect(logError).toHaveBeenCalled();
  });

  it("never leaks the DB error into the unauthenticated response body", async () => {
    queryRaw.mockRejectedValue(new Error("password authentication failed for user 'app'"));
    const res = await GET();
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});
