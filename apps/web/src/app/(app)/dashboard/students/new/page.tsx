import Link from "next/link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddStudentForm } from "./add-student-form";

// Silent onboarding entry point: stage a student (and later their mid-package
// balance) on the roster before going live. The student is created on hold,
// so no notifications fire until the teacher chooses to go live.
export default async function NewStudentPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();

  return (
    <main className="container space-y-6 py-10 lg:max-w-xl">
      <div>
        <Link href="/dashboard/students" className="text-sm underline">
          {t("web.dashboard.students.new.backLink")}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("web.dashboard.students.new.title")}</CardTitle>
          <CardDescription>{t("web.dashboard.students.new.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AddStudentForm defaultPhoneCountry={teacher.country} />
        </CardContent>
      </Card>
    </main>
  );
}
