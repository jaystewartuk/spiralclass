import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { formatTimeInZone } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { getCurrentStudent, requireStudent } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { ChatRoom } from "@/components/chat-room";
import { PeerLocalTime } from "@/components/chat/peer-local-time";
import { toChatWireMessage } from "@/lib/chat/wire";
import { TeacherAvatar, TeacherNameLink } from "@/components/teacher-identity";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";

// The tab and the back-button history read as the person you are talking to,
// not as a repeat of the site name. `getCurrentStudent` is the same cached
// lookup the layout already ran, so this costs one small select.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}): Promise<Metadata> {
  const student = await getCurrentStudent();
  const t = await getT();
  if (!student) return { title: t("chat.messages") };
  const { teacherId } = await params;
  const studentIds = await studentIdentityIds(student);
  const link = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
    select: { teacher: { select: { name: true } } },
  });
  return { title: link?.teacher.name ?? t("chat.messages") };
}

export default async function StudentChatPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();
  const { teacherId } = await params;

  const studentIds = await studentIdentityIds(student);
  const ts = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
    include: {
      teacher: { select: { name: true, photoPath: true, timezone: true, updatedAt: true } },
    },
  });
  if (!ts) notFound();
  const teacherPhotoUrl = teacherPhotoPublicUrl(
    ts.teacher.photoPath,
    ts.teacher.updatedAt.getTime(),
  );

  const rows = await prisma.message.findMany({
    where: { teacherId, studentId: ts.studentId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { reactions: { select: { reactorRole: true, emoji: true } } },
  });

  // Mark teacher messages as read on open.
  await prisma.message.updateMany({
    where: { teacherId, studentId: ts.studentId, senderRole: "teacher", readAt: null },
    data: { readAt: new Date() },
  });

  const initialMessages = await Promise.all(rows.reverse().map(toChatWireMessage));

  return (
    // `h-thread` is the viewport minus the sticky app header — the composer
    // stays put and only the message list scrolls. The side borders on a wide
    // window are what make the column read as a panel rather than as text
    // floating in the middle of the page.
    <main className="h-thread border-border mx-auto flex max-w-3xl flex-col lg:border-x">
      <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 flex shrink-0 items-center gap-2 border-b px-2 py-2 backdrop-blur lg:px-3">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link
            href="/my-classes/messages"
            aria-label={t("web.studentMessages.backToMessages")}
            className="text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <TeacherAvatar name={ts.teacher.name} photoUrl={teacherPhotoUrl} size={40} />
        <div className="min-w-0 flex-1">
          <Heading level={3} as="h1" className="truncate">
            <TeacherNameLink teacherId={teacherId} name={ts.teacher.name} />
          </Heading>
          <p className="text-muted-foreground truncate text-sm">
            <PeerLocalTime
              initialTime={formatTimeInZone(new Date(), ts.teacher.timezone, locale)}
              timeZone={ts.teacher.timezone}
              locale={locale}
            />
          </p>
        </div>
      </header>

      <ChatRoom
        messagesUrl={`/api/chat/student/${teacherId}`}
        voiceUrl={`/api/chat/student/${teacherId}/voice`}
        videoUrl={`/api/chat/student/${teacherId}/video`}
        imageUrl={`/api/chat/student/${teacherId}/image`}
        fileUrl={`/api/chat/student/${teacherId}/file`}
        myRole="student"
        peerName={ts.teacher.name}
        peerPhotoUrl={teacherPhotoUrl}
        locale={locale}
        initialMessages={initialMessages}
      />
    </main>
  );
}
