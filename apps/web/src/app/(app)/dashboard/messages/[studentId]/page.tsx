import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, UserRound } from "lucide-react";
import { formatTimeInZone } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { getCurrentTeacher, requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { ChatRoom } from "@/components/chat-room";
import { PeerLocalTime } from "@/components/chat/peer-local-time";
import { PersonAvatar } from "@/components/teacher-identity";
import { toChatWireMessage } from "@/lib/chat/wire";
import { studentPhotoUrl } from "@/lib/storage/student-photo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ studentId: string }>;
}): Promise<Metadata> {
  const teacher = await getCurrentTeacher();
  const t = await getT();
  if (!teacher) return { title: t("chat.messages") };
  const { studentId } = await params;
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    select: { student: { select: { name: true } } },
  });
  return { title: link?.student.name ?? t("chat.messages") };
}

export default async function TeacherChatPage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const { studentId } = await params;

  const ts = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    include: { student: { select: { name: true, photoPath: true, timezone: true } } },
  });
  if (!ts) notFound();
  const photoUrl = await studentPhotoUrl(ts.student.photoPath);

  const rows = await prisma.message.findMany({
    where: { teacherId: teacher.id, studentId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { reactions: { select: { reactorRole: true, emoji: true } } },
  });

  // Mark student messages as read on open.
  await prisma.message.updateMany({
    where: { teacherId: teacher.id, studentId, senderRole: "student", readAt: null },
    data: { readAt: new Date() },
  });

  const initialMessages = await Promise.all(rows.reverse().map(toChatWireMessage));
  const profileHref = `/dashboard/students/${studentId}`;

  // The height and the panel borders belong to the inbox layout now — this is
  // one pane inside it, so it simply fills what it is given. `<main>` because
  // the conversation IS this page's content: the rail beside it is navigation,
  // and this route had no main landmark at all before.
  return (
    <main className="flex h-full flex-col">
      <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 flex shrink-0 items-center gap-3 border-b px-2 py-2.5 backdrop-blur lg:px-4">
        {/* The back arrow is only an affordance while the list is a SCREEN.
            At `desktop-wide` the rail is on the left the whole time, so an
            arrow pointing at something already visible is just a control that
            can be pressed by mistake. */}
        <Button asChild variant="ghost" size="icon" className="desktop-wide:hidden shrink-0">
          <Link
            href="/dashboard/messages"
            aria-label={t("web.messages.backToMessages")}
            className="text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PersonAvatar name={ts.student.name} photoUrl={photoUrl} size={40} />
        <div className="min-w-0 flex-1">
          <Heading level={3} as="h1" className="truncate">
            <Link href={profileHref} className="hover:underline">
              {ts.student.name}
            </Link>
          </Heading>
          {ts.student.timezone ? (
            <p className="text-muted-foreground truncate text-sm">
              <PeerLocalTime
                initialTime={formatTimeInZone(new Date(), ts.student.timezone, locale)}
                timeZone={ts.student.timezone}
                locale={locale}
              />
            </p>
          ) : null}
        </div>
        {/* Named on a wide window, icon-only where the name would crowd the
            header — the accessible name is the same sentence either way. */}
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href={profileHref} aria-label={t("web.messages.openStudentProfile")}>
            <UserRound className="h-4 w-4" />
            <span className="desktop:inline hidden">{t("web.messages.studentProfile")}</span>
          </Link>
        </Button>
      </header>

      <ChatRoom
        messagesUrl={`/api/chat/teacher/${studentId}`}
        voiceUrl={`/api/chat/teacher/${studentId}/voice`}
        videoUrl={`/api/chat/teacher/${studentId}/video`}
        imageUrl={`/api/chat/teacher/${studentId}/image`}
        fileUrl={`/api/chat/teacher/${studentId}/file`}
        myRole="teacher"
        peerName={ts.student.name}
        peerPhotoUrl={photoUrl}
        locale={locale}
        initialMessages={initialMessages}
      />
    </main>
  );
}
