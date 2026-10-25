import type { Teacher } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lessonInsightsConsentOk } from "@/lib/lesson-notes/consent";
import { captionsConsentOk } from "@/lib/captions/consent";
import type { TFunction } from "@/lib/i18n-translate";
import { StudentLearningProfileCard } from "./student-learning-profile-card";

/**
 * What she has been recorded as needing — the longitudinal profile on its own
 * view, with the controls that decide whether it is built (consent) and who
 * sees it (sharing).
 *
 * It used to share the Learning tab with the level and goal forms. Those are
 * things a teacher sets; this is a record she reads, and it grows with the
 * relationship, so it gets the whole width.
 */
export async function ProfileTab({
  studentId,
  teacher,
  t,
  link,
}: {
  studentId: string;
  teacher: Teacher;
  t: TFunction;
  link: {
    shareProgress: boolean;
    isMinor: boolean;
    insightsConsentAt: Date | null;
    guardianConsentAt: Date | null;
    captionsConsentAt: Date | null;
    captionsGuardianConsentAt: Date | null;
  };
}) {
  const now = new Date();
  const [learningProfile, lastClass] = await Promise.all([
    prisma.studentLearningProfile.findUnique({
      where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
      select: { profile: true },
    }),
    // A teacher-added focus area belongs to a class: the most recent one that
    // actually took place (cancelled and moved classes did not).
    prisma.booking.findFirst({
      where: {
        teacherId: teacher.id,
        studentId,
        status: { in: ["completed", "scheduled", "no_show"] },
        scheduledStart: { lte: now },
      },
      orderBy: { scheduledStart: "desc" },
      select: { id: true },
    }),
  ]);

  return (
    <div className="max-w-3xl">
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
        captionsSelfConsented={link.captionsConsentAt != null}
        addToBookingId={lastClass?.id ?? null}
        t={t}
      />
    </div>
  );
}
