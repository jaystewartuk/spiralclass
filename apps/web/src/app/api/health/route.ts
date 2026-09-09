import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const log = logger({ surface: "health" });

// Liveness + readiness probe for external uptime monitors (Better Stack,
// UptimeRobot, etc.). Returns 200 only when the app can reach Postgres;
// 503 otherwise. Body is intentionally tiny so monitor providers can do
// keyword checks. The endpoint is unauthenticated, so it deliberately
// does NOT disclose the build SHA or the raw DB error — those are logged
// server-side where a failing probe can still be matched to a deploy.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 5_000;

// How long after process start a failed DB check is treated as cold-start
// warmup rather than an incident.
//
// `auto_stop_machines = 'stop'` means machines boot on demand, and the first
// Neon connection after a boot can exceed this route's own 5s DB timeout.
// fly.production.toml already tolerates that — `grace_period = '30s'` on the
// health check exists for exactly this window — so the machine recovers on its
// own with no operator action. The route nonetheless reported every one to
// Sentry via log.error, which is where SPIRALCLASS-21's 126 production events
// came from: all within seconds of a boot, none of them an outage.
//
// That noise is the actual risk. An `error`-level issue that fires routinely
// trains everyone to ignore it, and buries a genuine DB failure on the day it
// matters. Inside the window we still log and still return 503 — the probe
// must fail, and Fly must be the thing that decides whether the machine is
// healthy — we just don't page for it.
//
// 45s: past the ~8s boot plus the 30s grace period, with headroom. A DB
// failure that outlasts it reports as an error exactly as before.
const BOOT_WARMUP_SECONDS = 45;

export async function GET() {
  const startedAt = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`DB health check timed out after ${DB_TIMEOUT_MS}ms`)),
          DB_TIMEOUT_MS,
        ),
      ),
    ]);
    return NextResponse.json(
      { status: "ok", db: "ok", latencyMs: Date.now() - startedAt },
      { status: 200 },
    );
  } catch (err) {
    // Log the detail (commit + message) where only operators can see it,
    // not in the unauthenticated response body.
    const uptimeSeconds = process.uptime();
    const duringWarmup = uptimeSeconds < BOOT_WARMUP_SECONDS;
    const fields = {
      commit: process.env.NEXT_DEPLOYMENT_ID ?? "unknown",
      uptimeSeconds: Math.round(uptimeSeconds),
    };
    if (duringWarmup) {
      // warn, not error — logger.error is what forwards to Sentry.
      log.warn("DB check failed during boot warmup", {
        ...fields,
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      log.error("DB check failed", err, fields);
    }
    return NextResponse.json(
      { status: "degraded", db: "fail", latencyMs: Date.now() - startedAt },
      { status: 503 },
    );
  }
}
