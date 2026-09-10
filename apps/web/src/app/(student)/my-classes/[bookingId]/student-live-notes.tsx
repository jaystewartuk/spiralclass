"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";
import { useT } from "@/components/locale-provider";

type LiveNote = { id: string; body: string };

// Student-side live notes panel (live-notes-panel.md phase 1c). When the class
// window is open we poll and re-run the server component on an interval, so a
// note the teacher adds or edits mid-class appears without a manual refresh
// (was a Supabase Realtime `postgres_changes` subscription — moved to portable
// polling per D-49/D-44 to keep the DB provider-swappable; see
// use-visibility-polling.ts).
//
// Security is NOT trusted to any client-side signal: router.refresh() always
// re-runs the server component, which re-applies the server-side audience
// filter + the class-window gate (D-15) on every poll.
export function StudentLiveNotes({
  notes,
  windowOpen,
}: {
  notes: LiveNote[];
  windowOpen: boolean;
}) {
  const router = useRouter();
  const t = useT();

  // Only poll while the window is open. Outside it there's nothing to show
  // and the student can't read the rows anyway.
  useVisibilityPolling(router.refresh, { enabled: windowOpen });

  // Nothing to show yet (window open but no instructions): stay mounted so the
  // subscription is live and the first note pops in, but render nothing.
  if (notes.length === 0) return null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle className="text-lg">{t("web.myClasses.call.duringYourClass")}</CardTitle>
        <CardDescription>{t("web.myClasses.liveNotes.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {notes.map((n) => (
            <li key={n.id} className="bg-background rounded-md border px-3 py-2">
              {n.body}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
