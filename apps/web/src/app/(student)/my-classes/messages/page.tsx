import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { MessageSquare, PenSquare } from "lucide-react";
import { FALLBACK_TIMEZONE } from "@spiralclass/shared";
import { requireStudent } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { studentChatThreads } from "@/lib/chat/threads";
import { formatThreadTimestamp, threadPreviewText } from "@/lib/chat/thread-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PersonAvatar } from "@/components/teacher-identity";
import { cn } from "@/lib/utils";

export default async function StudentMessagesPage() {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();
  const threads = await studentChatThreads(await studentIdentityIds(student));
  // Multiple teachers can appear in one student's thread list, each
  // potentially in a different zone — "today" must resolve against the
  // viewing student's own zone, not any one teacher's. Same fallback as
  // my-classes/calendar/page.tsx for a student with no saved zone yet.
  const viewerTz = student.timezone ?? FALLBACK_TIMEZONE;

  return (
    <PageShell width="default">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title={t("chat.messages")} description={t("web.studentMessages.subtitle")} />
        <Button asChild size="sm" className="shrink-0">
          <Link href="/my-classes/messages/new">
            <PenSquare className="h-4 w-4" />
            {t("chat.newMessage")}
          </Link>
        </Button>
      </div>

      {threads.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={t("web.studentMessages.empty")}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/my-classes/messages/new">
                <PenSquare className="h-4 w-4" />
                {t("chat.newMessage")}
              </Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {threads.map((thread, i) => {
                const lastMsg = thread.lastMessage;
                // The preview and the timestamp come from the same helpers the
                // teacher inbox uses, so a photo does not read as "voice
                // message" on one side of the same conversation and as "Photo"
                // on the other.
                const preview = threadPreviewText(thread, t);
                const hasUnread = thread.unreadCount > 0;
                return (
                  <li key={`${thread.teacherId}-${thread.studentId}`}>
                    <Link
                      href={`/my-classes/messages/${thread.teacherId}`}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50",
                        i === 0 && "rounded-t-lg",
                        i === threads.length - 1 && "rounded-b-lg",
                      )}
                    >
                      <PersonAvatar name={thread.teacherName} size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "truncate text-sm",
                              hasUnread ? "font-semibold" : "font-medium",
                            )}
                          >
                            {thread.teacherName}
                          </span>
                          {lastMsg && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatThreadTimestamp(lastMsg.createdAt, locale, viewerTz, t)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {preview && (
                            <p
                              className={cn(
                                "flex-1 truncate text-xs",
                                hasUnread ? "font-medium text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {lastMsg?.senderRole === "student"
                                ? t("web.messages.youPrefix", { preview })
                                : preview}
                            </p>
                          )}
                          {hasUnread && (
                            <Badge className="h-5 min-w-5 shrink-0 rounded-full px-1.5 text-sm">
                              {thread.unreadCount > 99 ? "99+" : thread.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
