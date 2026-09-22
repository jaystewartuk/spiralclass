import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/page-header";
import { requireStudent } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { profileSchema, type StudentProfile } from "@/lib/lesson-notes/profile";
import { seedVocabularyReviews } from "@/lib/lesson-notes/srs";
import { attachVocabContext } from "@/lib/lesson-notes/vocab-context";
import { VocabReview } from "./vocab-review";

// Phase F, Half 2: the student's
// own progress — built from the SAME teacher-validated profile, shown only when
// the teacher has shared it (per-student toggle). Framed as encouragement (what's
// improving up front, what to keep practising gently), never a deficiency list.
// App-scoped to the signed-in student's identity set, like every student read.

export const dynamic = "force-dynamic";

// Split a profile into the student-facing framing: improving (celebrate) vs
// keep-practising (focus + new), as plain skill labels.
function studentFraming(profile: StudentProfile): { improving: string[]; practise: string[] } {
  const improving: string[] = [];
  const practise: string[] = [];
  for (const skills of Object.values(profile.byCategory)) {
    for (const [skill, entry] of Object.entries(skills)) {
      const label = skill.replace(/_/g, " ");
      if (entry.trend === "improving") improving.push(label);
      else practise.push(label);
    }
  }
  return { improving, practise };
}

export default async function ProgressPage() {
  const student = await requireStudent();
  const t = await getT();
  const ids = await studentIdentityIds(student);

  // Only pairs the teacher has shared.
  const shared = await prisma.teacherStudent.findMany({
    where: { studentId: { in: ids }, shareProgress: true },
    select: { teacherId: true, studentId: true, teacher: { select: { name: true } } },
  });

  const profiles = shared.length
    ? await prisma.studentLearningProfile.findMany({
        where: { OR: shared.map((s) => ({ teacherId: s.teacherId, studentId: s.studentId })) },
        select: { teacherId: true, studentId: true, profile: true },
      })
    : [];

  // Lazily seed the SRS queue from each shared profile's vocabulary (no-op for
  // terms already scheduled — preserves review progress).
  const now = new Date();
  for (const row of profiles) {
    const parsed = profileSchema.safeParse(row.profile);
    if (!parsed.success) continue;
    const terms = parsed.data.vocabulary.map((v) => v.term);
    if (terms.length) {
      await seedVocabularyReviews(prisma, {
        teacherId: row.teacherId,
        studentId: row.studentId,
        terms,
        now,
      });
    }
  }

  const dueRows = ids.length
    ? await prisma.vocabularyReview.findMany({
        where: { studentId: { in: ids }, dueAt: { lte: now } },
        select: { id: true, term: true, teacherId: true, studentId: true },
        orderBy: { dueAt: "asc" },
        take: 50,
      })
    : [];
  const due = await attachVocabContext(prisma, dueRows);

  const teacherName = new Map(shared.map((s) => [s.teacherId, s.teacher.name]));
  const views = profiles
    .map((row) => {
      const parsed = profileSchema.safeParse(row.profile);
      return parsed.success ? { teacherId: row.teacherId, ...studentFraming(parsed.data) } : null;
    })
    .filter((v): v is { teacherId: string; improving: string[]; practise: string[] } => v !== null)
    .filter((v) => v.improving.length > 0 || v.practise.length > 0);

  const hasAnything = views.length > 0 || due.length > 0;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <PageHeader title={t("progress.title")} />

      {!hasAnything && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("progress.empty")}
          </CardContent>
        </Card>
      )}

      {views.map((v) => (
        <Card key={v.teacherId}>
          <CardHeader>
            <CardTitle className="text-lg">
              {t("progress.with")} {teacherName.get(v.teacherId) ?? t("progress.yourTeacher")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {v.improving.length > 0 && (
              <div className="space-y-1">
                <h4 className="font-medium">{t("progress.improving")}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {v.improving.map((s) => (
                    <Badge key={s} variant="secondary">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {v.practise.length > 0 && (
              <div className="space-y-1">
                <h4 className="font-medium">{t("progress.practise")}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {v.practise.map((s) => (
                    <Badge key={s} variant="outline">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {due.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("progress.vocabTitle")}</CardTitle>
            <CardDescription>{t("progress.vocabHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            <VocabReview terms={due} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
