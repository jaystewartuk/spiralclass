"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The live-notes card overlaid on the call's top-left corner — the teacher's
// cues and the student's instructions both render inside it.
//
// It collapses to its title. Open, it is 288px wide, and on a phone that is
// most of the stage: a teacher reading a shared material on her phone could
// not see the material's first lines because her own notes sat on top of
// them, with no way to put them away. Collapsed or open is remembered per
// browser and per role — a preference about one screen, like the caption
// preferences (lib/captions/preferences.ts), with no business in the database.
export function CallNotesCard({
  title,
  count,
  storageKey,
  children,
}: {
  title: string;
  // Shown beside the title while collapsed, so a closed card still says
  // there is something in it.
  count: number;
  storageKey: string;
  children: React.ReactNode;
}) {
  // Read while initialising: the card only ever renders inside the call, which
  // is client-only (class-call-client.tsx, ssr:false), so there is no server
  // render to disagree with. Storage can throw (private windows, blocked site
  // data) — open is the safe default.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) === "collapsed";
    } catch {
      return false;
    }
  });
  const bodyId = useId();

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      if (next) window.localStorage.setItem(storageKey, "collapsed");
      else window.localStorage.removeItem(storageKey);
    } catch {
      // Not remembered; still toggled for this call.
    }
  }

  return (
    <div
      className={cn(
        "pointer-events-auto rounded-lg bg-background/90 text-foreground shadow-lg backdrop-blur",
        collapsed ? "w-fit" : "w-full",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={toggle}
        className="w-full justify-between gap-2 text-muted-foreground"
      >
        <span>
          {title}
          {collapsed && <span className="ml-1.5 tabular-nums">({count})</span>}
        </span>
        <ChevronDown
          aria-hidden
          className={cn("h-4 w-4 shrink-0 transition-transform", collapsed && "-rotate-90")}
        />
      </Button>
      <div id={bodyId} hidden={collapsed} className="px-3 pb-3">
        {children}
      </div>
    </div>
  );
}
