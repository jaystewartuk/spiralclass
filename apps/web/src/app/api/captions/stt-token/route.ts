import { z } from "zod";
import { cloudRecognitionRefusal } from "@spiralclass/shared";
import { requireApiCallParticipant } from "@/lib/api/auth";
import { errorResponse, handle, readJsonBody } from "@/lib/api/route";
import { isSameOrigin } from "@/lib/auth/csrf";
import { captionAccessFor } from "@/lib/captions/access";
import { cloudCaptionsConfigured } from "@/lib/captions/config";
import {
  deepgramListenUrl,
  deepgramLiveLanguage,
  grantDeepgramToken,
} from "@/lib/captions/deepgram-live";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { classCallRoom } from "@/lib/video/provider";
import { listRoomParticipantAttributes } from "@/lib/video/room";

// POST /api/captions/stt-token — live captions' phone-to-phone fallback
// (D-185's addendum). When no browser in a class can recognise speech, each
// speaker's own browser streams its microphone to Deepgram, and this route
// hands it what it needs to open that socket: a token from Deepgram's
// /v1/auth/grant that only has to outlive the handshake, and the listen URL,
// whose model and language are resolved here from the booking — the client
// never names a language (D-185).
//
// The token is only ever for the CALLER'S OWN speech, so the body names just
// the class. Everything the other caption routes check is checked again
// (captionAccessFor: signed in, a party to the class, the flag and the
// teacher's plan), plus the student's consent when she is the caller (D-22).
//
// This route is what spends Deepgram minutes, so it also checks the fallback
// is WARRANTED: LiveKit's own view of the room must show the caller and
// someone else present, the teacher's switch on, and no browser saying it can
// recognise — otherwise a signed-in participant could stream from a room a
// computer is captioning for free. Grants are budgeted per caller per class
// and per class per day; each grant is logged, never any audio. The time
// actually streamed is not visible from here (the browser talks to Deepgram
// directly), so Deepgram's usage view and the operator's usage alert are the
// authoritative measure.

const log = logger({ surface: "captions" });

const bodySchema = z.object({ bookingId: z.string().min(1).max(64) });

// A healthy stream takes one token per class; a reconnect takes another. An
// hour of a phone dropping its connection every few minutes stays inside this.
const PER_CALLER_PER_CLASS = {
  scope: "captions-stt-token",
  limit: 30,
  windowMs: 60 * 60_000,
};
// Both speakers, several hours of reconnects. A class that hits this is not a
// class.
const PER_CLASS_PER_DAY = {
  scope: "captions-stt-token-class",
  limit: 120,
  windowMs: 24 * 60 * 60_000,
};

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return errorResponse(403, "cross-origin");

  return handle(async () => {
    const participant = await requireApiCallParticipant(req);
    const { bookingId } = await readJsonBody(req, bodySchema);

    const access = await captionAccessFor(participant, bookingId);
    if (!access.ok) {
      if (access.reason === "not-found") return errorResponse(404, "not-found");
      return errorResponse(403, access.reason === "disabled" ? "captions-off" : "not-entitled");
    }
    const { session, callerId } = access;
    const speaker = session.role;
    if (speaker === "student" && !session.studentConsent) {
      return errorResponse(403, "no-consent");
    }
    if (!cloudCaptionsConfigured()) return errorResponse(403, "cloud-off");

    const language = deepgramLiveLanguage(session.recognitionLocales[speaker]);
    if (!language) return errorResponse(422, "unsupported-language");

    for (const [limit, key] of [
      [PER_CALLER_PER_CLASS, `${bookingId}:${callerId}`],
      [PER_CLASS_PER_DAY, bookingId],
    ] as const) {
      const verdict = await rateLimit(key, limit);
      if (!verdict.ok) {
        log.warn("caption stt token rate-limited", { bookingId, scope: limit.scope });
        return errorResponse(429, "rate-limited", undefined, {
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }

    // The caller's LiveKit identity is her own id (the call pages mint it
    // so), which is what callerId is.
    let participants;
    try {
      participants = await listRoomParticipantAttributes(classCallRoom(bookingId));
    } catch {
      return errorResponse(503, "room-unavailable");
    }
    if (!participants) return errorResponse(503, "room-unavailable");
    const refusal = cloudRecognitionRefusal({
      participants,
      callerIdentity: callerId,
      teacherIdentity: session.teacherIdentity,
    });
    if (refusal) {
      log.info("caption stt token refused", { bookingId, speaker, refusal });
      return errorResponse(409, "not-warranted", undefined, { refusal });
    }

    const grant = await grantDeepgramToken();
    log.info("caption stt token granted", {
      bookingId,
      speaker,
      language,
      ok: grant.ok,
      ...(grant.ok ? {} : { reason: grant.reason, status: grant.status }),
    });
    if (!grant.ok) return errorResponse(502, "grant-failed");

    return {
      ok: true,
      token: grant.token,
      url: deepgramListenUrl(language),
      expiresInSeconds: grant.expiresInSeconds,
    } as const;
  });
}
