"use client";

import dynamic from "next/dynamic";
import type { CallMaterial } from "@spiralclass/shared";
import type { CallGrant } from "@/lib/video/provider";
import type { NudgeResult } from "@/lib/video/nudge";

// livekit-client is browser-only (WebRTC, media devices). Load the call UI with
// ssr:false so none of it runs during the server render pass — server components
// can't pass ssr:false to next/dynamic themselves, so this thin client boundary
// does it. The call pages render <ClassCallClient> instead of <ClassCall>.
const ClassCall = dynamic(() => import("./class-call").then((m) => m.ClassCall), {
  ssr: false,
});

export function ClassCallClient({
  grant,
  backHref,
  chatHref,
  overlay,
  canRecord,
  canCaption,
  captionsConsentMissing,
  bookingId,
  role,
  scheduledStartAt,
  materials,
  canBrowseLibrary,
  onNudge,
  onBookmark,
  onLeave,
}: {
  grant: CallGrant;
  backHref: string;
  // The call's own route — accepted by CallSessionInput
  // (call-session-context.tsx) but not by ClassCall (see that type's own
  // note), so it's simply not in this destructure — the caller can still
  // spread a CallSessionInput at this component without a type error (an
  // extra property on a spread isn't an excess-property-check site the way
  // an object literal is), it's just never read here.
  callHref?: string;
  chatHref?: string;
  overlay?: React.ReactNode;
  canRecord?: boolean;
  canCaption?: boolean;
  captionsConsentMissing?: boolean;
  bookingId?: string;
  role?: "teacher" | "student";
  scheduledStartAt?: string;
  materials?: CallMaterial[];
  canBrowseLibrary?: boolean;
  onNudge?: () => Promise<NudgeResult>;
  onBookmark?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  onLeave?: () => void;
}) {
  return (
    <ClassCall
      grant={grant}
      backHref={backHref}
      chatHref={chatHref}
      overlay={overlay}
      canRecord={canRecord}
      canCaption={canCaption}
      captionsConsentMissing={captionsConsentMissing}
      bookingId={bookingId}
      role={role}
      scheduledStartAt={scheduledStartAt}
      materials={materials}
      canBrowseLibrary={canBrowseLibrary}
      onNudge={onNudge}
      onBookmark={onBookmark}
      onLeave={onLeave}
    />
  );
}
