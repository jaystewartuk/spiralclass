import { z } from "zod";

import { ApiAuthError, requireApiOnboardedTeacher } from "@/lib/api/auth";
import {
  prepareLibraryMaterialPrompt,
  recordLibraryMaterialGeneration,
} from "@/lib/materials/handlers";
import { generateMaterialStream } from "@/lib/ai/anthropic";
import { hasAnthropicCreds } from "@/lib/env";
import { CLASS_CONTENT_MAX_CHARS } from "@/lib/materials/config";
import { isAppLocale, DEFAULT_LOCALE } from "@spiralclass/shared";
import { logger } from "@/lib/logger";

const log = logger({ surface: "materials-generate-stream" });

// Live "watch it write" library-material generation. Streams Markdown deltas
// as the model produces them. Auth is resolved from request headers
// (requireApiOnboardedTeacher → better-auth getSession), which recognizes
// BOTH the web cookie session AND the mobile Bearer token, so one route serves
// both clients. The gate/validate/cap all run BEFORE the stream starts (real
// HTTP status codes); once streaming, a trailing DONE sentinel marks success —
// its ABSENCE tells the client the generation failed mid-stream.
//
// Wire format is Server-Sent Events (`text/event-stream`), NOT raw text. This
// is load-bearing after the D-70 move off Vercel to self-hosted Docker behind
// Cloudflare + Fly: a plain `text/plain` body gets buffered/compressed by the
// edge (Cloudflare ignores `X-Accel-Buffering` and compresses ordinary text),
// so every delta arrived in one burst and the "watch it write" UI collapsed
// back into a plain spinner. `text/event-stream` is the one content type the
// whole chain (Cloudflare, Fly, Next) passes through unbuffered and never
// compresses. Each delta is one `data:` frame carrying the JSON-encoded chunk
// (JSON keeps it single-line so the blank line stays a clean frame delimiter);
// success is a final `data:` frame carrying the DONE sentinel.

// U+001F (unit separator) — sent as the last frame's payload on success. Won't
// appear in generated Markdown; the client treats its absence as a failure.
const DONE = "\u001F";

const bodySchema = z.object({
  topic: z.string().max(2000).optional().default(""),
  levelId: z.string().nullish(),
  focusTagIds: z.array(z.string()).max(24).optional().default([]),
  templateId: z.string().nullish(),
  language: z.string().max(40).nullish(),
  locale: z.string().optional(),
});

const STATUS: Record<"not-pro" | "invalid" | "cap", number> = {
  "not-pro": 403,
  invalid: 422,
  cap: 429,
};

function jsonError(status: number, reason: string, message?: string): Response {
  return Response.json({ ok: false, reason, message: message ?? reason }, { status });
}

export async function POST(req: Request): Promise<Response> {
  let teacherId: string;
  try {
    const teacher = await requireApiOnboardedTeacher(req);
    teacherId = teacher.id;
  } catch (err) {
    if (err instanceof ApiAuthError) return jsonError(err.status, err.reason);
    throw err;
  }

  if (!hasAnthropicCreds()) return jsonError(503, "not-configured");

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid-body");
  const { topic, levelId, focusTagIds, templateId, language } = parsed.data;
  const locale = isAppLocale(parsed.data.locale) ? parsed.data.locale : DEFAULT_LOCALE;

  const prep = await prepareLibraryMaterialPrompt({
    teacherId,
    topic,
    levelId,
    focusTagIds,
    templateId,
    locale,
    language,
  });
  if (!prep.ok) return jsonError(STATUS[prep.code], prep.code, prep.message);

  const encoder = new TextEncoder();
  // One SSE `data:` frame carrying `value` JSON-encoded. JSON.stringify keeps
  // the payload on a single line (newlines become `\n`), so the blank line
  // between frames is never ambiguous.
  const frame = (value: string) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A leading comment nudges intermediaries to flush the response head and
      // start streaming immediately rather than waiting for the first frame.
      controller.enqueue(encoder.encode(":ok\n\n"));
      let total = 0;
      try {
        for await (const delta of generateMaterialStream(prep.promptInput)) {
          // Bound the streamed body to the same ceiling the non-streaming path
          // slices to; stop enqueuing once reached (the model usually stops on
          // its own well before this).
          const remaining = CLASS_CONTENT_MAX_CHARS - total;
          if (remaining <= 0) break;
          const chunk = delta.length > remaining ? delta.slice(0, remaining) : delta;
          total += chunk.length;
          controller.enqueue(frame(chunk));
        }
        // Success — burn one quota row, then mark the stream complete.
        await recordLibraryMaterialGeneration(teacherId, prep.meta);
        controller.enqueue(frame(DONE));
        controller.close();
      } catch (err) {
        // Closing WITHOUT the DONE frame signals failure to the client.
        // "Failures don't burn quota" — recordLibraryMaterialGeneration never ran.
        log.error("stream generation failed", err);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      // SSE — the one content type Cloudflare/Fly/Next stream unbuffered and
      // never compress. See the header comment for why plain text regressed.
      "content-type": "text/event-stream; charset=utf-8",
      // Belt and suspenders for any nginx-family proxy in the chain: forbid
      // transforming (compressing) the body and disable proxy buffering.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
