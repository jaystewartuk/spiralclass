import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Process-liveness probe — no Postgres query, deliberately. This is what
// fly.production.toml / fly.preview.toml point their `[[http_service.checks]]`
// at (interval 15s). `/api/health` (the sibling route) does the real DB
// readiness check and stays the target for external uptime monitors
// (UptimeRobot/BetterStack) and synthetic.yml, which poll far less often.
//
// Why split them: Neon suspends an idle compute after ~5 minutes with no
// query. A DB-backed check on a 15s interval never lets 5 idle minutes
// accumulate, so the primary branch on both the production AND preview Neon
// projects had been running 100% of the current billing period instead of
// scaling to zero — confirmed via `neonctl api /projects/<id>/endpoints`
// showing `suspended_at: undefined` since each branch's creation, while every
// other (checkpoint/dev) branch suspended normally ~5 min after use. That
// continuous 0.25 CU floor across two projects was the primary driver of an
// unexpectedly large Neon bill (diagnosed 2026-08-07).
//
// Trade-off this accepts: Fly's own health check can no longer detect
// "this machine can't reach Postgres" and replace it on that basis. In
// practice that isn't much of a safety net — restarting one machine doesn't
// fix a real Neon outage (every machine sees the same DB), and a genuine
// per-machine network fault still fails the process's other liveness
// signals over time. Real DB-down detection still exists — /api/health,
// via UptimeRobot/BetterStack and synthetic.yml — it just no longer runs
// with a period tighter than Neon's suspend window.
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
