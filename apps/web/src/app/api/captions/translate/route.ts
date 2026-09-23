import { z } from "zod";
import { baseLanguage, MAX_CAPTION_CHARS } from "@spiralclass/shared";
import { requireApiCallParticipant } from "@/lib/api/auth";
import { errorResponse, handle, readJsonBody } from "@/lib/api/route";
import { isSameOrigin } from "@/lib/auth/csrf";
import { captionAccessFor } from "@/lib/captions/access";
import { translateWithGoogle } from "@/lib/captions/google-translate";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/captions/translate — the server half of live-caption translation
// (D-185). A browser that recognised one finished utterance, and has no
// on-device translator for the pair (every phone, and every desktop browser
// but Chrome), sends the text here and publishes what comes back.
//
// The body names only WHOSE speech it is (`speaker`) and the text. The
// languages are never taken from the request: the server resolves both from
// the booking, so a client cannot turn this into a general translation
// endpoint by asking for a pair the class does not use. Each call re-checks
// everything captionAccessFor checks, plus the student's consent when it is
// her speech (D-22) — the browser also checks it before recognising her, but
// the browser is not the boundary.
//
// This route spends money past Google's monthly free allowance, so it is
// budgeted in characters — what Google bills — twice over: per caller per
// minute (a burst limit a real speaker never reaches) and per class per day
// (a ceiling a real lesson never reaches). Both are env-configurable like
// every rate limit. The character count of every call is logged, never the
// text, so monthly usage can be estimated from the logs; the operator's
// Google Cloud budget alert is the authoritative warning.

const log = logger({ surface: "captions" });

const bodySchema = z.object({
  bookingId: z.string().min(1).max(64),
  speaker: z.enum(["teacher", "student"]),
  // The client splits a long utterance (splitUtterance) rather than sending
  // it whole, so anything over the cap is a caller this route should refuse.
  text: z.string().trim().min(1).max(MAX_CAPTION_CHARS),
});

// A fast speaker produces about 900 characters a minute, and one browser can
// be recognising both people; 3,000 leaves room for that and nothing like
// room for a loop.
const PER_MINUTE = { scope: "captions-translate", limit: 3_000, windowMs: 60_000 };
// About three hours of both people talking without pause. A class that hits
// this is not a class.
const PER_CLASS_PER_DAY = {
  scope: "captions-translate-class",
  limit: 150_000,
  windowMs: 24 * 60 * 60_000,
};

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return errorResponse(403, "cross-origin");

  return handle(async () => {
    const participant = await requireApiCallParticipant(req);
    const { bookingId, speaker, text } = await readJsonBody(req, bodySchema);

    const access = await captionAccessFor(participant, bookingId);
    if (!access.ok) {
      if (access.reason === "not-found") return errorResponse(404, "not-found");
      return errorResponse(403, access.reason === "disabled" ? "captions-off" : "not-entitled");
    }
    const { session, callerId } = access;
    if (speaker === "student" && !session.studentConsent) {
      return errorResponse(403, "no-consent");
    }

    const direction = session.directions[speaker];
    // Same language on both sides: the recognised text IS the caption, and
    // Google is not asked (or paid) to return it unchanged.
    if (baseLanguage(direction.source) === baseLanguage(direction.target)) {
      return { ok: true, text } as const;
    }

    const chars = text.length;
    for (const [limit, key] of [
      [PER_MINUTE, `${bookingId}:${callerId}`],
      [PER_CLASS_PER_DAY, bookingId],
    ] as const) {
      const verdict = await rateLimit(key, { ...limit, cost: chars });
      if (!verdict.ok) {
        log.warn("caption translation rate-limited", { bookingId, scope: limit.scope, chars });
        return errorResponse(429, "rate-limited", undefined, {
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }

    const result = await translateWithGoogle(text, direction.source, direction.target);
    log.info("caption translated", {
      bookingId,
      speaker,
      chars,
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason, status: result.status }),
    });
    if (!result.ok) {
      // One clean error for every vendor failure: the client drops this line
      // and keeps captioning; the reason and status are in the log above.
      return errorResponse(502, "translate-failed");
    }
    return { ok: true, text: result.text } as const;
  });
}
