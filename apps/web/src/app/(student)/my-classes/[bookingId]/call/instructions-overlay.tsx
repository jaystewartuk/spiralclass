"use client";

import { useRouter } from "next/navigation";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";

type LiveNote = { id: string; body: string };

// The student's live-notes overlay during the call itself (live-notes-panel.md
// step 3, D-15/D-16). The page server-renders `notes` once at load, same as the
// booking-detail StudentLiveNotes card — but unlike that card, this had no
// realtime subscription: a note the teacher added or edited after the student
// already joined the call never appeared until the student reloaded the call
// page mid-class (not something anyone naturally does while on a video call).
// Mirrors StudentLiveNotes' polling exactly (see its comment for the security
// reasoning — router.refresh() always re-applies the server-side audience
// filter + class-window gate). Safe to refresh mid-call: the LiveKit
// connection is keyed on callConnectionKey (media-server URL + retry counter),
// which deliberately excludes the per-render token, so a router.refresh() here
// re-fetches notes without dropping the call — the same mechanism that already
// lets the Record button's revalidatePath refresh the route mid-call.
export function InstructionsOverlay({
  notes,
  windowOpen,
  en,
}: {
  notes: LiveNote[];
  windowOpen: boolean;
  en: boolean;
}) {
  const router = useRouter();

  // Poll BEFORE the empty-early-return so this keeps running even with no notes
  // yet — a note the teacher adds mid-call appears on the next tick without a
  // reload. The empty state renders nothing at all (not an empty card): the
  // call's overlay slot is a bare positioning wrapper now, so returning null
  // here means no visible container over the video. See ClassCall's overlay
  // note, which passes null the same way.
  useVisibilityPolling(router.refresh, { enabled: windowOpen });

  if (notes.length === 0) return null;
  return (
    <div className="bg-background/90 text-foreground space-y-2 rounded-lg p-3 shadow-lg backdrop-blur">
      <h3 className="text-muted-foreground text-sm font-medium">
        {en ? "During your class" : "Durante tu clase"}
      </h3>
      <ul className="space-y-1 text-sm">
        {notes.map((n) => (
          <li key={n.id}>{n.body}</li>
        ))}
      </ul>
    </div>
  );
}
