import type { Teacher } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { getTeacherLevels } from "@/lib/levels";
import { lessonInsightsConsentOk } from "@/lib/lesson-notes/consent";
import { captionsConsentOk } from "@/lib/captions/consent";
import type { TFunction } from "@/lib/i18n-translate";
import { StudentLevelForm } from "./student-level-form";
import { StudentProfileForm } from "./student-profile-form";
import { StudentLearningProfileCard } from "./student-learning-profile-card";

/**
 * What to teach this person, and what she has been recorded as needing.
 *
 * The three things here — the level that decides what she can browse, the goal
 * and interests every AI generation is personalised from, and the longitudinal
 * profile built out of confirmed lesson insights — were three cards among
 * eleven, sitting between the packages and the contact form. They are one
 * subject, so they are one view.
 *
 * Two columns above `lg` because the left half is two short forms and the right
 * half is a list that grows with the relationship; stacked, the profile spent
 * most of its life below the fold.
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
    shareProgress: boolean;
    isMinor: boolean;
    insightsConsentAt: Date | null;
    guardianConsentAt: Date | null;
    captionsConsentAt: Date | null;
    captionsGuardianConsentAt: Date | null;
  };
}) {
  const [levels, learningProfile] = await Promise.all([
    getTeacherLevels(teacher.id),
    prisma.studentLearningProfile.findUnique({
      where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
      select: { profile: true },
    }),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <div className="space-y-6">
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
            <StudentProfileForm
              studentId={studentId}
              interests={link.interests}
              goals={link.goals}
            />
          </CardContent>
        </Card>
      </div>

      <StudentLearningProfileCard
        profile={learningProfile?.profile ?? null}
        studentId={studentId}
        shareProgress={link.shareProgress}
        insightsConsented={lessonInsightsConsentOk({
          isMinor: link.isMinor,
          insightsConsentAt: link.insightsConsentAt,
          guardianConsentAt: link.guardianConsentAt,
        })}
        isMinor={link.isMinor}
        captionsGuardianConsented={captionsConsentOk({
          isMinor: link.isMinor,
          captionsConsentAt: link.captionsConsentAt,
          captionsGuardianConsentAt: link.captionsGuardianConsentAt,
        })}
        t={t}
      />
    </div>
  );
}
