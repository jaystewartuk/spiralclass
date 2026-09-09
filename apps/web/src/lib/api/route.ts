// Thin route-handler helper for handlers that take a plain `Request` and
// answer JSON. Centralizes body parsing, zod validation, and converting an
// `ApiAuthError` into the right status code, so each route file is a one-liner
// around its handler.
//
// It survived a large route deletion because a web route still uses it
// (`api/internal/captions/room-config`), and lost the two exports that went
// with those routes: `json()` (unused) and `localeFromRequest()`.

import { NextResponse } from "next/server";
import { z, type ZodSchema } from "zod";

import { flushAnalytics } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";
import { ApiAuthError } from "./auth";

const log = logger({ surface: "api" });

type Result<T> = T | NextResponse;

export function errorResponse(
  status: number,
  reason: string,
  message?: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ ok: false, reason, message: message ?? reason, ...extra }, { status });
}

export async function handle<T>(fn: () => Promise<Result<T>>): Promise<NextResponse> {
  try {
    const result = await fn();
    // Drain any analytics the handler emitted (trackServerEvent) before the
    // serverless function can freeze — posthog-node is configured flushAt:1 /
    // flushInterval:0 so the POST otherwise rides a background task that the
    // freeze drops. No-op when no client was initialized (read-only handlers).
    await flushAnalytics();
    if (result instanceof NextResponse) return result;
    return NextResponse.json(result as object, { status: 200 });
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return errorResponse(err.status, err.reason, undefined, err.extra);
    }
    if (err instanceof z.ZodError) {
      return errorResponse(400, "invalid-body", err.issues.map((i) => i.message).join("; "));
    }
    if (err instanceof Error) {
      // Log + Sentry server-side, but never leak the raw message to the
      // client — Prisma/Postgres internals aid enumeration and recon for an
      // unauthenticated caller. The body stays generic.
      log.error("handler threw", err);
      return errorResponse(500, "internal-error");
    }
    return errorResponse(500, "internal-error");
  }
}

export async function readJsonBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  const raw = await req.json().catch(() => null);
  return schema.parse(raw);
}
