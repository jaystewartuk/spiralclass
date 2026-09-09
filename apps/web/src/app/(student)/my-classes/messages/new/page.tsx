import { requireStudent } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { RecipientPicker } from "@/components/recipient-picker";

// Student-side "new message" picker: the teachers the student has an active
// relationship with (across identity rows, deduped), linking into the existing
// conversation route. Matches the send route's auth gate so every listed teacher
// is actually messageable.
export default async function NewStudentMessagePage() {
  const student = await requireStudent();
  const t = await getT();

  const studentIds = await studentIdentityIds(student);
  const rows = await prisma.teacherStudent.findMany({
    where: { studentId: { in: studentIds }, archivedAt: null },
    include: { teacher: { select: { id: true, name: true } } },
    orderBy: { teacher: { name: "asc" } },
  });

  const seen = new Set<string>();
  const recipients: { id: string; name: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.teacher.id)) continue;
    seen.add(r.teacher.id);
    recipients.push({ id: r.teacher.id, name: r.teacher.name });
  }

  return (
    <RecipientPicker
      title={t("chat.newMessage")}
      subtitle={t("chat.pickTeacher")}
      backHref="/my-classes/messages"
      hrefBase="/my-classes/messages"
      recipients={recipients}
      searchPlaceholder={t("chat.searchTeachers")}
      emptyLabel={t("chat.noTeachers")}
      noMatchLabel={t("chat.noMatch")}
    />
  );
}
