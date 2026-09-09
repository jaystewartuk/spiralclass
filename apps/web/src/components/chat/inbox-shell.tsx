"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** The inbox root. Everything below it lives inside these two panes. */
const INBOX_ROOT = "/dashboard/messages";

/**
 * Which of the two panes is on screen, at each width.
 *
 * A wide window shows both: the conversation list on the left and whatever is
 * open on the right. A narrow one shows exactly one of them, and WHICH one is
 * the whole state of the screen — the list at the inbox root, the conversation
 * once you have opened one. That is why this is a client component: the layout
 * that renders it is deliberately NOT re-rendered when the route below it
 * changes (which is what lets the rail keep its scroll position and its data
 * across every thread you open), so the route has to be read from the client
 * router or the panes would answer for whichever route happened to mount
 * first.
 */
export function InboxShell({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  const atRoot = usePathname() === INBOX_ROOT;

  return (
    <div className="flex h-thread overflow-hidden">
      {/* A plain element, not an `<aside>`: the list inside it is already a
          named `<nav>` landmark, and wrapping that in a complementary one
          would announce the same region twice under two different names. */}
      <div
        className={cn(
          "shrink-0 border-border desktop-wide:w-rail desktop-wide:border-r",
          // The rule between the panes only means anything while there ARE
          // two panes — at the root on a narrow window it is a hairline down
          // the edge of the screen.
          atRoot ? "flex w-full" : "hidden border-r desktop-wide:flex",
        )}
      >
        {rail}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 overflow-y-auto",
          // At the root on a narrow window the list IS the screen; an empty
          // pane beside it would take half the width to say nothing.
          atRoot && "hidden desktop-wide:block",
        )}
      >
        {children}
      </div>
    </div>
  );
}
