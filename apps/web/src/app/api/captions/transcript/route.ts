import { z } from "zod";
import { MAX_CAPTION_CHARS } from "@spiralclass/shared";
import { requireApiCallParticipant } from "@/lib/api/auth";
import { errorResponse, handle, readJsonBody } from "@/lib/api/route";
import { isSameOrigin } from "@/lib/auth/csrf";
import { captionAccessFor } from "@/lib/captions/access";
import { inngest } from "@/lib/inngest/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import {
  MAX_LINE_DURATION_MS,
  appendBrowserTranscriptLine,
} from "@/lib/transcription/browser-transcript";

// POST /api/captions/transcript — keep one recognised caption line as part of
// the class's transcript for lesson insights (D-189). The browser that
// recognised a finished utterance (its own speaker's, or the other person's
// when their device cannot — D-185) sends the source text here, and the
// server appends it to the booking's LessonTranscript.
//
// Everything captionAccessFor checks is re-checked per line: the caller is a
// party to this class, captions are on for it, the teacher's plan includes
// them. On top, the class's session must say `transcriptCapture` — the
// transcription flag is on AND this pairing's insights consent (D-22) is
// recorded — or the line is refused; a browser only posts when the session
// says so, but the browser is not the boundary. A student's line additionally
// needs her captions consent, as the translate route requires.
//
// The route stores text, never audio, and costs nothing per call beyond the
// database write, so the rate limits bound abuse rather than spend: one
// person speaks about 900 characters a minute, and one browser may be
// recognising both people.

const log = logger({ surface: "browser-transcript" });

const bodySchema = z.object({
  bookingId: z.string().min(1).max(64),
  speaker: z.enum(["teacher", "student"]),
  // The client splits a long utterance (splitUtterance) before posting it.
  text: z.string().trim().min(1).max(MAX_CAPTION_CHARS),
  durationMs: z.number().int().min(0).max(MAX_LINE_DURATION_MS),
});

const PER_MINUTE = { scope: "captions-transcript", limit: 3_000, windowMs: 60_000 };
const PER_CLASS_PER_DAY = {
  scope: "captions-transcript-class",
  limit: 150_000,
  windowMs: 24 * 60 * 60_000,
};

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return errorResponse(403, "cross-origin");

  return handle(async () => {
    const participant = await requireApiCallParticipant(req);
    const { bookingId, speaker, text, durationMs } = await readJsonBody(req, bodySchema);

    const access = await captionAccessFor(participant, bookingId);
    if (!access.ok) {
      if (access.reason === "not-found") return errorResponse(404, "not-found");
      return errorResponse(403, access.reason === "disabled" ? "captions-off" : "not-entitled");
    }
    const { session, callerId } = access;
    if (!session.transcriptCapture) return errorResponse(403, "transcript-off");
    if (speaker === "student" && !session.studentConsent) {
      return errorResponse(403, "no-consent");
    }

    const chars = text.length;
    for (const [limit, key] of [
      [PER_MINUTE, `${bookingId}:${callerId}`],
      [PER_CLASS_PER_DAY, bookingId],
    ] as const) {
      const verdict = await rateLimit(key, { ...limit, cost: chars });
      if (!verdict.ok) {
        log.warn("transcript line rate-limited", { bookingId, scope: limit.scope, chars });
        return errorResponse(429, "rate-limited", undefined, {
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }

    const outcome = await appendBrowserTranscriptLine(prisma, {
      bookingId,
      teacherId: session.teacherIdentity,
      speaker,
      text,
      durationMs,
    });
    if (outcome.started) {
      // The first kept line of the class arms the completion fallback: if the
      // room_finished webhook never arrives, the transcript is still
      // finalised after the class's scheduled end.
      await inngest.send({ name: "lesson.transcript.capturing", data: { bookingId } });
    }
    return { ok: true, kept: outcome.kept } as const;
  });
}
