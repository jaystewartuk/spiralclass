import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { RecipientPicker } from "@/components/recipient-picker";

// Teacher-side "new message" picker: the active roster, linking each student
// into the existing conversation route (which opens fine with no messages yet).
export default async function NewTeacherMessagePage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();

  // Exclude archived and not-live (onboardingHoldAt set) students: a not-live
  // student is staged silently, so they aren't a "start a conversation" target.
  const rows = await prisma.teacherStudent.findMany({
    where: { teacherId: teacher.id, archivedAt: null, onboardingHoldAt: null },
    include: { student: { select: { id: true, name: true } } },
    orderBy: { student: { name: "asc" } },
  });
  const recipients = rows.map((r) => ({ id: r.student.id, name: r.student.name }));

  return (
    <RecipientPicker
      title={t("web.messages.newMessage")}
      subtitle={t("web.messages.newPickStudent")}
      backHref="/dashboard/messages"
      hrefBase="/dashboard/messages"
      recipients={recipients}
      searchPlaceholder={t("web.messages.searchStudents")}
      emptyLabel={t("web.messages.newNoStudents")}
      noMatchLabel={t("web.messages.noStudentsMatch")}
    />
  );
}
