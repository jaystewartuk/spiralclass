"use client";

import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import * as Sentry from "@sentry/nextjs";

// Single place that owns the *browser-side* user identity for BOTH
// telemetry tools:
//
//   • posthog-js  — so client autocapture, session replay, feature flags,
//     and surveys resolve to the same Person the server pipeline
//     identifies (identifyServerUser in lib/analytics/posthog.ts).
//   • Sentry      — so the "Report a problem" dialog pre-fills the
//     name/email fields (report-problem-dialog.tsx reads them off the
//     current scope user, keyed `username`/`email`) and so every client
//     error AND every report is attributed to a known person instead of
//     an anonymous browser. The server already sets the Sentry user in
//     lib/auth.ts / lib/admin.ts; this mirrors it on the client, which
//     the server init can't reach.
//
// Render it from the authenticated layouts, fed by the server-resolved
// user. `distinctId` MUST match the id the server uses (teacher.id /
// student.id / admin actor id) or PostHog will split one user across two
// Persons.
type Props = {
  distinctId: string;
  email?: string | null;
  name?: string | null;
  role: "teacher" | "student" | "admin";
  // Tenant the user belongs to (teacher workspace). When set, enables
  // group analytics so usage can be sliced per teacher, not just per
  // user. Omitted for students (they can belong to several teachers).
  teacherId?: string | null;
};

export function PostHogIdentify({ distinctId, email, name, role, teacherId }: Props) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    // Re-identify only when the resolved person actually changes — avoids
    // shipping a fresh $identify on every client navigation. The first
    // call (anon id !== distinctId) is what stitches the prior anonymous
    // funnel session onto the now-known user.
    if (posthog.get_distinct_id() !== distinctId) {
      posthog.identify(distinctId, {
        role,
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
      });
    }
    if (teacherId) posthog.group("teacher", teacherId);

    // Mirror the identity onto the client Sentry scope. `username` (not
    // `name`) is the key Sentry's own user model carries a display name in,
    // and what the report-a-problem dialog reads for its name field, so set
    // it there. No-op when the Sentry client isn't initialised (missing
    // DSN) — setUser just writes to an inert scope.
    Sentry.setUser({
      id: distinctId,
      ...(email ? { email } : {}),
      ...(name ? { username: name } : {}),
    });
  }, [posthog, distinctId, email, name, role, teacherId]);

  return null;
}
