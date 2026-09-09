import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listActiveCalls } from "@/lib/live-calls/service";
import { logger } from "@/lib/logger";

const log = logger({ surface: "admin-live-calls" });

// Live Calls dashboard's primary read — polled client-side (see
// use-visibility-polling.ts) rather than server-rendered on every tick, so
// the admin page doesn't do a full navigation just to refresh a number.
// Cheap: one LiveKit listRooms() call + two batched Prisma queries, no
// matter how many rooms are active.
export async function GET(): Promise<Response> {
  await requireAdmin("support");

  try {
    const result = await listActiveCalls(Date.now());
    if (!result) {
      return NextResponse.json({ ok: false, reason: "not-configured" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("failed to list active calls", err);
    return NextResponse.json({ ok: false, reason: "upstream-unavailable" }, { status: 502 });
  }
}
