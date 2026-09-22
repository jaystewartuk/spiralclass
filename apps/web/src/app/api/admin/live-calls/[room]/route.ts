import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { getCallDetail } from "@/lib/live-calls/service";
import { logger } from "@/lib/logger";

const log = logger({ surface: "admin-live-calls" });

// Full participant/track detail for one room — the expensive per-room
// LiveKit call the list view defers until an admin opens a room (see
// service.ts's lazy-load design).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ room: string }> },
): Promise<Response> {
  await requireAdmin("support");
  const { room } = await params;

  try {
    const detail = await getCallDetail(room, Date.now());
    if (detail === null) {
      // Ambiguous on purpose between "LiveKit not configured" and "room
      // already ended" — either way there's nothing live to show, and the
      // dashboard's own "not configured" banner (from the list endpoint)
      // already covers the configuration case.
      return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, room: detail });
  } catch (err) {
    log.error("failed to load call detail", err, { room });
    return NextResponse.json({ ok: false, reason: "upstream-unavailable" }, { status: 502 });
  }
}
