"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PenSquare, Search } from "lucide-react";
import type { AppLocale, ChatThread } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { PersonAvatar } from "@/components/teacher-identity";
import { useT } from "@/components/locale-provider";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";
import {
  filterThreadsByName,
  formatThreadTimestamp,
  threadPreviewText,
} from "@/lib/chat/thread-list";
import { cn } from "@/lib/utils";

/** A roster is worth searching at about the point it stops fitting on screen. */
const SEARCH_THRESHOLD = 6;

/** The inbox root — the route at which this list is the whole page. */
const INBOX_ROOT = "/dashboard/messages";

/**
 * The conversation list.
 *
 * One component for two placements, because they are the same rows: the
 * persistent rail beside an open thread on a wide window, and the whole screen
 * on a phone. Rendering them from two files is how the two drifted before —
 * the rail is what a teacher steers the whole inbox by, and it has to agree
 * with the list she taps into it from.
 *
 * It polls rather than relying on the server render: the segment layout that
 * mounts the rail is NOT re-rendered when she navigates between threads inside
 * it, so a server-rendered rail would show the unread counts as they stood
 * when she first opened Messages and never move again.
 */
export function ThreadList({
  threads: initialThreads,
  locale,
  timezone,
  className,
}: {
  threads: ChatThread[];
  locale: AppLocale;
  /** The VIEWING teacher's zone — "today" is hers, not the server's. */
  timezone: string;
  className?: string;
}) {
  const t = useT();
  const pathname = usePathname();
  // Seeded once, then owned by the poll below. There is deliberately no effect
  // syncing a later `initialThreads` back over it: the layout that renders
  // this is never re-rendered while the inbox is open, so a changed prop would
  // only ever be a fresh mount anyway — and an effect that copied it in would
  // periodically overwrite newer polled state with the render-time snapshot.
  const [threads, setThreads] = useState(initialThreads);
  const [query, setQuery] = useState("");

  // Opening a conversation marks it read on the server, but the rail only
  // learns that on its next poll — four seconds of a row you are looking at
  // still claiming to be unread. Zero it on the way out instead; the poll
  // then confirms what the row already says.
  const markRead = useCallback((studentId: string) => {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.studentId === studentId ? { ...thread, unreadCount: 0 } : thread,
      ),
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/teacher/threads", { credentials: "same-origin" });
      if (!res.ok) return;
      setThreads((await res.json()) as ChatThread[]);
    } catch {
      // Network blip — the next tick retries. A stale list is better than an
      // error banner over a list that is still perfectly readable.
    }
  }, []);
  useVisibilityPolling(refresh);

  const filtered = useMemo(() => filterThreadsByName(threads, query), [threads, query]);
  const atRoot = pathname === INBOX_ROOT;
  const showSearch = threads.length >= SEARCH_THRESHOLD;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3">
        {/* At the inbox root this list IS the page, so its heading is the
            page's `h1`; beside an open conversation the conversation owns
            that, and this is the section heading above it. The SIZE does not
            move either way — the tag is an outline decision, not a visual
            one (see the Heading primitive). */}
        <Heading level={4} as={atRoot ? "h1" : "h2"} className="flex-1">
          {t("web.messages.title")}
        </Heading>
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard/messages/new">
            <PenSquare className="h-4 w-4" />
            {t("web.messages.newMessage")}
          </Link>
        </Button>
      </div>

      {showSearch && (
        <div className="relative shrink-0 border-b border-border px-3 py-2">
          <Search
            className="pointer-events-none absolute top-1/2 left-6 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("web.messages.searchConversations")}
            aria-label={t("web.messages.searchConversations")}
            className="pl-9"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {query.trim() ? t("web.messages.noStudentsMatch") : t("web.messages.noConversationsYet")}
        </p>
      ) : (
        <nav
          aria-label={t("web.messages.conversationsLabel")}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <ul>
            {filtered.map((thread) => {
              const href = `/dashboard/messages/${thread.studentId}`;
              const active = pathname === href;
              const preview = threadPreviewText(thread, t);
              const hasUnread = thread.unreadCount > 0;
              return (
                <li key={thread.studentId}>
                  <Link
                    href={href}
                    onClick={() => markRead(thread.studentId)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 px-3 py-3 transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden",
                      // The active row is a filled surface, not a left rule:
                      // at rail width the rule sat outside the row's own
                      // padding and read as a divider rather than a selection.
                      active ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    {/* Monogram, not the student's photo: those live in a
                        private bucket, so drawing them here would mean one
                        signed-URL round trip per conversation before the list
                        could render at all. The thread header, where there is
                        exactly one, shows the real face. */}
                    <PersonAvatar name={thread.studentName} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-base",
                            hasUnread ? "font-bold" : "font-medium",
                          )}
                        >
                          {thread.studentName}
                        </span>
                        {thread.lastMessage && (
                          <time
                            dateTime={thread.lastMessage.createdAt}
                            className={cn(
                              "shrink-0 text-sm",
                              hasUnread ? "font-semibold text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {formatThreadTimestamp(
                              thread.lastMessage.createdAt,
                              locale,
                              timezone,
                              t,
                            )}
                          </time>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-sm",
                            hasUnread ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {preview
                            ? thread.lastMessage?.senderRole === "teacher"
                              ? t("web.messages.youPrefix", { preview })
                              : preview
                            : null}
                        </span>
                        <UnreadBadge
                          count={thread.unreadCount}
                          max={99}
                          srLabel={t("web.messages.unreadCount", { count: thread.unreadCount })}
                          className="shrink-0"
                        />
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
