import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { isSameOrigin } from "@/lib/auth/csrf";
import { rateLimit } from "@/lib/rate-limit";
import { disconnectCallParticipant } from "@/lib/live-calls/service";

const bodySchema = z.object({ reason: z.string().trim().min(1, "Reason required").max(280) });

const STATUS: Record<string, number> = {
  unavailable: 503,
  "not-found": 404,
  "provider-error": 502,
};

// Force-disconnects one participant; the room stays open for whoever else
// is in it. Same audit + rate-limit treatment as the sibling end-room route.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ room: string; identity: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, reason: "cross-origin" }, { status: 403 });
  }

  const actor = await requireAdmin("support");
  const { room, identity } = await params;

  const limited = await rateLimit(actor.id, {
    scope: "admin-live-calls-action",
    limit: 15,
    windowMs: 5 * 60_000,
  });
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const result = await disconnectCallParticipant(room, identity, actor, parsed.data.reason);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, reason: result.reason },
      { status: STATUS[result.reason] ?? 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
