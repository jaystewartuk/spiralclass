import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Users } from "lucide-react";
import { requireStudent } from "@/lib/auth";
import { getT, getPreferredLocale } from "@/lib/i18n";
import { listStudentTeachers } from "@/lib/students/teacher-profile";
import { languageDisplayName } from "@/lib/language-name";
import { Card, CardContent } from "@/components/ui/card";
import { TeacherAvatar } from "@/components/teacher-identity";
import Link from "next/link";

// One teacher → skip straight to their profile; multiple → a list first, per
// the "students should never have to search for this" goal.
export default async function StudentTeachersPage() {
  const student = await requireStudent();
  const t = await getT();
  const locale = await getPreferredLocale();
  const teachers = await listStudentTeachers(student);

  if (teachers.length === 1) {
    redirect(`/my-classes/teachers/${teachers[0].id}`);
  }

  return (
    <PageShell width="default">
      <PageHeader title={t("web.myTeachers.title")} description={t("web.myTeachers.subtitle")} />

      {teachers.length === 0 ? (
        <EmptyState icon={Users} title={t("web.myTeachers.empty")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {teachers.map((teacher, i) => {
                const language = languageDisplayName(teacher.targetLanguage, locale);
                return (
                  <li key={teacher.id}>
                    <Link
                      href={`/my-classes/teachers/${teacher.id}`}
                      className={`hover:bg-muted/50 flex items-center gap-3 px-4 py-3.5 transition-colors ${
                        i === 0 ? "rounded-t-lg" : ""
                      } ${i === teachers.length - 1 ? "rounded-b-lg" : ""}`}
                    >
                      <TeacherAvatar name={teacher.name} photoUrl={teacher.photoUrl} size={44} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{teacher.name}</p>
                        {language && (
                          <p className="text-muted-foreground truncate text-xs">{language}</p>
                        )}
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
