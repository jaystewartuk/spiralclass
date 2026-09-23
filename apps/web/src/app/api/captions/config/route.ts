import { z } from "zod";
import { requireApiCallParticipant } from "@/lib/api/auth";
import { errorResponse, handle, readJsonBody } from "@/lib/api/route";
import { isSameOrigin } from "@/lib/auth/csrf";
import { captionAccessFor } from "@/lib/captions/access";

// POST /api/captions/config — everything a participant's browser needs to
// caption this class (D-185): both speakers' language directions, the
// recognition locale for each, the teacher's LiveKit identity, and whether
// the student has consented. Called when the teacher turns captions on, and
// polled while they stay on, so a consent revoked or a language changed
// mid-class reaches both browsers within a poll. Either participant may call
// it; nobody else gets past captionAccessFor.
//
// "Captions are off for this class" is an answer, not an error: the flag,
// a missing key and the teacher's plan all resolve to `enabled: false`, so the
// client can stop quietly. A booking the caller is not a party to is a 404.

const bodySchema = z.object({ bookingId: z.string().min(1).max(64) });

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return errorResponse(403, "cross-origin");

  return handle(async () => {
    const participant = await requireApiCallParticipant(req);
    const { bookingId } = await readJsonBody(req, bodySchema);
    const access = await captionAccessFor(participant, bookingId);
    if (!access.ok) {
      if (access.reason === "not-found") return errorResponse(404, "not-found");
      return { ok: true, enabled: false } as const;
    }
    return { ok: true, enabled: true, session: access.session } as const;
  });
}
