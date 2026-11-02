import type { Teacher } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTeacherLevels } from "@/lib/levels";
import type { TFunction } from "@/lib/i18n-translate";
import { StudentLevelForm } from "./student-level-form";
import { StudentProfileForm } from "./student-profile-form";

/**
 * What to teach this person: the level that decides what she can browse, and
 * the goal and interests every AI generation is personalised from. What she
 * has been recorded as needing is the Profile tab's job (tab-profile.tsx).
 */
export async function LearningTab({
  studentId,
  teacher,
  t,
  link,
}: {
  studentId: string;
  teacher: Teacher;
  t: TFunction;
  link: {
    levelId: string | null;
    interests: string | null;
    goals: string | null;
  };
}) {
  const levels = await getTeacherLevels(teacher.id);

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg" as="h2">
            {t("web.dashboard.students.section.level")}
          </CardTitle>
          <CardDescription>{t("web.dashboard.students.level.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StudentLevelForm
            studentId={studentId}
            currentLevelId={link.levelId}
            levels={levels.map((l) => ({ id: l.id, label: l.label }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg" as="h2">
            {t("web.dashboard.students.profile.title")}
          </CardTitle>
          <CardDescription>{t("web.dashboard.students.profile.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StudentProfileForm studentId={studentId} interests={link.interests} goals={link.goals} />
        </CardContent>
      </Card>
    </div>
  );
}
