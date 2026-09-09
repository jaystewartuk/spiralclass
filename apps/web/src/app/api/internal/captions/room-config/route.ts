import { z } from "zod";
import { errorResponse, handle, readJsonBody } from "@/lib/api/route";
import { captionsAgentAuthOk } from "@/lib/captions/internal-auth";
import { liveCaptionsEnabled } from "@/lib/captions/config";
import { resolveClassCallRoomConfig } from "@/lib/captions/class-access";
import { bookingIdFromCallRoom } from "@/lib/video/provider";
import { gateProFeature } from "@/lib/subscriptions/enforce";

// Called by the self-hosted LiveKit captions Agent
// (packages/livekit-captions-agent) once per room it joins, and again on a
// ~60s poll for the room's lifetime — this is what closes the "no live
// consent-revocation" gap the client-driven design had (consent was only
// ever checked once, at token-mint time). Given just the raw LiveKit room
// name, resolves the booking and returns everything the Agent needs to
// decide whether/how to caption each side: both directions' language pair,
// the Pro-entitlement gate, and the student consent gate (a teacher's own
// mic is never gated, matching every other caption route in this codebase).
//
// Auth is a shared secret (captionsAgentAuthOk), not a session/CSRF check —
// the caller is a trusted backend process on a different box, not a browser.

const bodySchema = z.object({ room: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  if (!captionsAgentAuthOk(req)) {
    return errorResponse(404, "not-found");
  }

  return handle(async () => {
    if (!liveCaptionsEnabled()) {
      return { ok: true, enabled: false } as const;
    }

    const { room } = await readJsonBody(req, bodySchema);
    const bookingId = bookingIdFromCallRoom(room);
    if (!bookingId) {
      // Not a class-call room (a foreign name) — the Agent has nothing to do
      // here in this phase.
      return { ok: true, enabled: false } as const;
    }

    const config = await resolveClassCallRoomConfig(bookingId);
    if (!config) {
      return errorResponse(404, "not-found");
    }

    const gate = await gateProFeature(config.teacherId, "lesson_notes");
    if (!gate.ok) {
      return { ok: true, enabled: false } as const;
    }

    return {
      ok: true,
      enabled: true,
      bookingId: config.bookingId,
      teacherId: config.teacherId,
      studentId: config.studentId,
      teacherDirection: config.teacherDirection,
      studentDirection: config.studentDirection,
      studentCaptionsAllowed: config.studentCaptionsAllowed,
    } as const;
  });
}
