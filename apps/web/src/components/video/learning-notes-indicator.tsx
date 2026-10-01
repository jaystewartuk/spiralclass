"use client";

import { useEffect, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";

// The sign that this class's captions are being kept as its transcript for
// learning insights — shown to both people, the way Meet, Zoom and Teams show
// that notes or a transcript are being taken:
//
//   1. A notice when it starts. Each time it turns on, not once per browser:
//      captions can be turned off and on mid-class, and the person who missed
//      the first notice is exactly the one the second is for.
//   2. A small icon in the top bar for as long as it is on. It is a quiet
//      chip beside the clock, not a sentence over the video, because the
//      student has already consented to this before the class; the icon is a
//      reminder that it is happening, not a request.
//   3. Tap the icon for what is kept and what is not.
//
// It replaced a "Transcript kept for learning insights" pill in the status
// stack, which said the same thing in a way teachers found alarming.
//
// The notice is a hook rather than part of the icon because the top bar
// unmounts while the call is minimised: an icon that announced on mount would
// announce again on every restore.
export function useLearningNotesNotice(active: boolean) {
  const t = useT();
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      // Twice sonner's default: two sentences to read mid-class.
      toast(t("call.notesStartedTitle"), {
        description: t("call.notesExplain"),
        duration: 8000,
      });
    }
    wasActive.current = active;
  }, [active, t]);
}

// Rendered only while notes are on, so a popover left open when they stop
// does not come back open when they resume.
export function LearningNotesIndicator() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t("call.notesOn")}
        title={t("call.notesOn")}
        data-testid="learning-notes-indicator"
        // The clock chip's shape and colours beside it; `ghost` would repaint
        // it with a page-background hover on the call's dark bar.
        className="h-7 rounded-full bg-overlay-1 px-2.5 text-on-dark-muted hover:bg-overlay-2 hover:text-white active:bg-overlay-2"
      >
        <NotebookPen className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label={t("call.notesStartedTitle")}
          className="absolute top-full left-1/2 z-50 mt-2 w-72 -translate-x-1/2 rounded-2xl bg-background p-4 text-left text-sm text-foreground shadow-lg"
        >
          <p className="font-semibold">{t("call.notesStartedTitle")}</p>
          <p className="mt-1 text-muted-foreground">{t("call.notesExplain")}</p>
          <a
            href="/privacy-notice"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("call.notesLearnMore")}
          </a>
        </div>
      )}
    </div>
  );
}
