import * as Sentry from "@sentry/nextjs";

// Minimal structured JSON logger. Replaces ad-hoc `console.log("[tag] msg", obj)`
// calls so log lines are queryable in Vercel's log drain (level + event + fields
// as JSON) and can be correlated across a single request via `correlationId`.
//
// Usage:
//   const log = logger({ surface: "stripe-webhook", correlationId: eventId });
//   log.info("handled", { code: outcome.code });
//   log.error("handler threw", err, { eventId });
//
// `error()` also forwards to Sentry.captureException so a single call both logs
// and alerts. Keep messages short and stable; put variable data in `fields`.

type Fields = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, err?: unknown, fields?: Fields): void;
  child(extra: Fields): Logger;
};

function emit(level: Level, base: Fields, message: string, fields?: Fields) {
  // debug is a no-op in production — skip the JSON.stringify + console call
  // entirely rather than just discarding the output at the console layer.
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  const line = { level, msg: message, ...base, ...(fields ?? {}) };
  // One JSON object per line — Vercel/most drains parse these into fields.
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else if (level === "debug") console.debug(serialized);
  else console.info(serialized);
}

// What to log when the thing thrown is not an Error.
//
// `String(err)` on any plain object is the string "[object Object]", which is
// how a real Stripe failure on the checkout path reached production logs
// carrying no information at all — the outage was visible, its cause was not.
// Two things produce a non-Error here: a library that throws a response-shaped
// object, and a caller who passes fields into the `err` slot by mistake (the
// signature is `error(message, err, fields)`, and `warn` takes fields second,
// so it is an easy slip). Both are worth being able to read.
//
// Sentry still receives the original value — this only decides the log line.
function describeNonError(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);

  // The fields Stripe (and most HTTP clients) put on a thrown object. Named
  // explicitly so the useful half survives even when the whole thing is huge.
  const e = err as Record<string, unknown>;
  const parts = (["type", "code", "statusCode", "requestId", "message"] as const)
    .filter((k) => e[k] !== undefined)
    .map((k) => `${k}=${String(e[k])}`);
  if (parts.length > 0) return parts.join(" ");

  try {
    // Bounded: a stray fields object is usually small, but a serialized
    // response body is not, and a log line is not the place for it.
    const json = JSON.stringify(err);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return "[unserializable non-Error value]";
  }
}

export function logger(base: Fields = {}): Logger {
  return {
    debug: (message, fields) => emit("debug", base, message, fields),
    info: (message, fields) => emit("info", base, message, fields),
    warn: (message, fields) => emit("warn", base, message, fields),
    error: (message, err, fields) => {
      emit("error", base, message, {
        ...fields,
        ...(err instanceof Error
          ? { error: err.message }
          : err !== undefined
            ? { error: describeNonError(err) }
            : {}),
      });
      if (err !== undefined) {
        Sentry.captureException(err, { tags: stringTags(base), extra: { ...base, ...fields } });
      } else {
        Sentry.captureMessage(message, {
          level: "error",
          tags: stringTags(base),
          extra: { ...base, ...fields },
        });
      }
    },
    child: (extra) => logger({ ...base, ...extra }),
  };
}

// Sentry tags must be primitive strings; coerce the base fields we use as tags.
function stringTags(base: Fields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// Derive a correlation id for a request: Vercel sets `x-vercel-id` on every
// inbound request; fall back to a random id so logs are always correlatable.
export function correlationIdFrom(req: { headers: { get(name: string): string | null } }): string {
  return req.headers.get("x-vercel-id") ?? crypto.randomUUID();
}
