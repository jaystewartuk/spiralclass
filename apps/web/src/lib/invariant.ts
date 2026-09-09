import * as Sentry from "@sentry/nextjs";

// Production tripwires. Use at write boundaries to catch logic bugs that
// no unit test thought to write — corrupt state at the call site rather
// than silently persisting it.
//
// Throws a typed Error and captures to Sentry with consistent tags so
// the Sentry "invariant" surface filters cleanly. The Sentry capture is
// fire-and-forget (no await); the throw happens unconditionally.

export class InvariantViolation extends Error {
  readonly name = "InvariantViolation";
  readonly invariant: string;
  readonly context: Record<string, unknown>;

  constructor(invariant: string, message: string, context: Record<string, unknown> = {}) {
    super(`[invariant: ${invariant}] ${message}`);
    this.invariant = invariant;
    this.context = context;
  }
}

export function invariant(
  condition: unknown,
  name: string,
  message: string,
  context: Record<string, unknown> = {},
): asserts condition {
  if (condition) return;
  const err = new InvariantViolation(name, message, context);
  Sentry.captureException(err, {
    tags: { surface: "invariant", invariant: name },
    extra: context,
  });
  throw err;
}
