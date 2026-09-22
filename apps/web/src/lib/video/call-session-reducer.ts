// The pure state transition behind CallSessionProvider (call-session-context.tsx)
// — split out so it's unit-testable without touching the .tsx component
// itself: this repo's unit suite deliberately doesn't import .tsx view
// components (see vitest.config.ts's coverage comment — they're Playwright/E2E
// territory), so a rule this consequential (refusing to swap the active
// booking mid-call) needs to live somewhere plain .ts can reach it.
import type { CallGrant } from "@/lib/video/provider";
import type { CallMaterial } from "@spiralclass/shared";
import type { NudgeResult } from "@/lib/video/nudge";

export type CallSessionInput = {
  bookingId: string;
  grant: CallGrant;
  backHref: string;
  callHref: string;
  // Who THIS viewer is on this call — attached to every call-analytics event
  //.
  role?: "teacher" | "student";
  // ISO timestamp of the booking's scheduled start, for the
  // minutesBeforeStart property on call_join_clicked/call_connection_started
  // below. NOT re-fetched on every re-render risk (unlike a server-fired
  // event would be, see the note on why call_page_opened was folded into the
  // client-side join event instead of firing from the call page itself) —
  // this is a plain prop read once at connect time.
  scheduledStartAt?: string;
  chatHref?: string;
  overlay?: React.ReactNode;
  canRecord?: boolean;
  canCaption?: boolean;
  // True when captions are otherwise available but THIS student hasn't given
  // her own consent yet (the captions architecture review P0) —
  // distinct from canCaption=false (feature off entirely), so the call UI can
  // show a hint pointing at her account settings instead of just hiding the
  // toggle with no explanation. Always false/undefined for the teacher role.
  captionsConsentMissing?: boolean;
  materials?: CallMaterial[];
  canBrowseLibrary?: boolean;
  onNudge?: () => Promise<NudgeResult>;
  onBookmark?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
};

export type CallSessionAction = { type: "start"; input: CallSessionInput } | { type: "end" };

// A booking already has the floor — starting a DIFFERENT booking's call while
// one is active is refused (the user must hang up first; nothing in the
// product lets two calls exist at once, and the LiveKit connection key isn't
// sensitive enough to the room to safely swap rooms under an already-mounted
// <ClassCall>). Starting the SAME booking again (e.g. the call page
// re-mounting on a fresh visit) refreshes the session with the new input.
export function callSessionReducer(
  session: CallSessionInput | null,
  action: CallSessionAction,
): CallSessionInput | null {
  switch (action.type) {
    case "start":
      if (session && session.bookingId !== action.input.bookingId) return session;
      return action.input;
    case "end":
      return null;
  }
}
