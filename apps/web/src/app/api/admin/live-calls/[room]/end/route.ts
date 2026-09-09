import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { isSameOrigin } from "@/lib/auth/csrf";
import { rateLimit } from "@/lib/rate-limit";
import { endCall } from "@/lib/live-calls/service";

const bodySchema = z.object({ reason: z.string().trim().min(1, "Reason required").max(280) });

const STATUS: Record<string, number> = {
  unavailable: 503,
  "not-found": 404,
  "provider-error": 502,
};

// Force-ends a room, disconnecting every participant — the "something is
// stuck, get everyone out" button. Always audited (lib/audit.ts's
// writeOverride) regardless of whether the room resolves to a booking/intro
// call, and rate-limited per admin so a runaway client can't hammer LiveKit.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ room: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, reason: "cross-origin" }, { status: 403 });
  }

  const actor = await requireAdmin("support");
  const { room } = await params;

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

  const result = await endCall(room, actor, parsed.data.reason);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, reason: result.reason },
      { status: STATUS[result.reason] ?? 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
