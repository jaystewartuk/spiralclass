import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { teacherChatThreads } from "@/lib/chat/threads";
import { InboxShell } from "@/components/chat/inbox-shell";
import { ThreadList } from "@/components/chat/thread-list";

/**
 * The inbox shell.
 *
 * Messages is a two-pane surface on a wide window — the conversation list on
 * the left, the open conversation on the right — and one pane at a time below
 * that. This is the layout because it is the one thing the previous version
 * could not do: an open thread was a 48rem column centred in a 1600px window
 * with the entire inbox behind a back button, so moving between two students
 * meant a round trip through a list that had nowhere to be but on screen.
 *
 * The list is fetched HERE rather than in the page so it survives navigation
 * between threads: a segment layout is not re-rendered when its child route
 * changes, which is exactly the property the rail wants — no refetch, no
 * flash, and a long roster keeps the place she scrolled it to. `ThreadList`
 * polls for the freshness that costs (see its own note), and `InboxShell`
 * reads the route from the client router for the same reason.
 */
export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const threads = await teacherChatThreads(teacher.id);

  return (
    <InboxShell
      rail={
        <ThreadList
          threads={threads}
          locale={locale}
          timezone={teacher.timezone}
          className="w-full"
        />
      }
    >
      {children}
    </InboxShell>
  );
}
