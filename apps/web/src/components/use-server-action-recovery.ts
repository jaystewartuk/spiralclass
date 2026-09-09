"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { recoverFromServerActionSkew } from "@/lib/server-action-recovery";

/**
 * The error-boundary half of deploy-skew recovery. Call it with the boundary's
 * `error`; it makes BOTH decisions — reload or not, report or not — from the
 * one fact that settles them, and returns `true` while a reload is in flight so
 * the boundary can render a quiet placeholder instead of a full error screen.
 *
 * The two decisions belong together because they are not the same question. A
 * skew error we RECOVER from is noise: the reload fixes it and nobody needs a
 * Sentry issue. A skew error we do NOT recover from — the sessionStorage
 * cooldown in `recoverFromServerActionSkew` refusing a second reload within 30s
 * — is the opposite: we already reloaded once and the page is STILL asking for
 * a chunk or action id that isn't there, which is a build that shipped broken
 * rather than a client that lagged a deploy. That is exactly the case worth
 * hearing about, and it is the one the user is looking at the error screen for.
 *
 * Each boundary used to answer these separately, with `if
 * (isServerActionVersionSkew(error)) return;` guarding its own
 * `Sentry.captureException` — which dropped the report on the message alone, so
 * a permanently missing chunk was as silent as a recovered one. Six boundaries
 * had their own copy of that. Deciding it here is what makes "recovered" and
 * "gave up" distinguishable at all: `recoverFromServerActionSkew`'s return
 * value is the only thing that knows which happened, and it is not observable
 * from outside this hook.
 */
export function useSkewRecoveryOrReport(error: unknown): boolean {
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    // True only when this IS skew and a reload was actually started. False for
    // an ordinary application error and for skew that has already burned its
    // one reload — both of which the user sees, so both get reported.
    if (recoverFromServerActionSkew(error)) {
      setRecovering(true);
      return;
    }
    Sentry.captureException(error);
  }, [error]);

  return recovering;
}
