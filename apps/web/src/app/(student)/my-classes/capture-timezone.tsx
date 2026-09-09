"use client";

import { useEffect } from "react";

// — capture the student's IANA timezone on first sign-in so the
// portal can render times in their wall clock alongside the teacher's.
//
// Only rendered by the layout when the server already knows `timezone` is
// unset (see my-classes/layout.tsx), so this never fires for a student who
// already has one. Fire-and-forget: /api/student/timezone is itself a
// one-shot no-op once set, and a flaky network here should never block
// anything the student is trying to do.
//
// This used to run from the /auth/callback client component (the GoTrue
// magic-link redeem page) right after a fresh sign-in. That page was
// deleted in the D-40 cutover to better-auth and nothing replaced this
// call site — timezone capture was silently broken until this component.
export function CaptureTimezone() {
  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    void fetch("/api/student/timezone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone }),
    }).catch(() => {
      // Best-effort — a future visit (still missing a timezone) retries.
    });
  }, []);

  return null;
}
