import Link from "next/link";
import { CheckCircle2, Users } from "lucide-react";
import { pageReadiness, planProgress } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { acquisitionHeadline } from "@/lib/marketing/analytics";
import { countCommunities } from "@/lib/marketing/communities";
import { ensureWeeklyPlan } from "@/lib/marketing/plan";
import { pageSignalsFor } from "@/lib/marketing/page-signals";
import { ActionRow, DoneRow, NextActionCard, type ActionCardItem } from "./action-card";
import { PageReadinessCard } from "./page-readiness-card";
import { RegeneratePlanButton } from "./regenerate-button";
import { ResultsSummaryCard } from "./results-summary-card";
import { SectionNav } from "./section-nav";
import { WeekProgress } from "./week-progress";

// "Get Students" — the acquisition command centre (D-125).
//
// The screen answers exactly one question: what should I do today to get my
// next student? Everything below follows from taking that literally.
//
// ## What was wrong with the version this replaces
//
// It answered the question three times at the same volume. "Today" held two
// cards; "This week" held the remaining five in identical cards; the finished
// ones sat in the same list again, dimmed with `opacity-60` — which is both
// the wrong signal (finished work competing with outstanding work) and a
// contrast cut on text D-140 says must stay legible. Nothing on the page was
// THE answer, and the numbers at the foot were a dead end with no route to the
// screen that explains them.
//
// ## The shape now
//
//   * ONE next action, with hero weight and full controls. A week's plan has an
//     order; the screen should say what is at the front of it.
//   * The rest as a scannable divided list, one tick-off control per row.
//   * Finished work in its own quiet section, carrying what it produced rather
//     than three unlabelled figures.
//   * Two columns from `lg`: the work she does on the left, the standing facts
//     she checks — her booking page, her last thirty days — on the right. Below
//     `lg` they stack in that same priority order, which is why the aside is
//     written after the main column rather than positioned with CSS. This is
//     the arrangement /dashboard already uses; the two hubs should not disagree
//     about where a teacher looks for what.
//
// The one inversion is D-125's arbiter: when the BOOKING PAGE is what is losing
// the students, it moves out of the aside and above everything, because telling
// a teacher to find more communities while nobody can buy from her page is how
// she spends a week on the wrong thing.
export default async function GetStudentsPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();

  const [plan, communityCount, headline, pageSignals] = await Promise.all([
    ensureWeeklyPlan({ teacherId: teacher.id }),
    countCommunities(teacher.id),
    acquisitionHeadline(teacher.id, 30),
    pageSignalsFor(teacher),
  ]);
  // Distribution (the plan below) and conversion (the page itself) are the two
  // halves of getting a student, and only one of them can be this week's work.
  // The arbiter decides which; see shared/marketing/page-readiness.ts for why
  // it is not just another planned action.
  const readiness = pageReadiness(pageSignals, headline);

  const items: ActionCardItem[] = (plan?.activities ?? []).map((a) => ({
    id: a.id,
    kind: a.kind,
    platform: a.platform,
    status: a.status,
    reason: a.reason,
    communityName: a.community?.name ?? null,
    studentName: a.student?.name ?? null,
    results: a.results,
  }));

  const progress = planProgress(items);
  const open = items.filter((i) => i.status === "planned" || i.status === "ready");
  const [next, ...rest] = open;
  const settled = items.filter((i) => i.status === "done" || i.status === "skipped");

  const hasCommunities = communityCount > 0;

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("web.getStudents.title")}
        description={t("web.getStudents.subtitle")}
        // Rebuilding the week acts on the whole screen, so it belongs here
        // rather than beside one of the sections it rewrites. It is hidden
        // before there is anything to rebuild.
        actions={hasCommunities ? <RegeneratePlanButton /> : null}
      />

      <SectionNav current="plan" />

      <WeekProgress progress={progress} />

      {readiness.isBottleneck ? (
        <PageReadinessCard readiness={readiness} slug={teacher.bookingSlug} />
      ) : null}

      {/* `items-start` so a short aside does not stretch to the main column's
          height and leave its last card floating in whitespace. */}
      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          {/* Nothing to post into: say the real next action rather than showing
              an empty plan, which reads as the product being broken. */}
          {!hasCommunities ? (
            <EmptyState
              icon={Users}
              title={t("web.getStudents.noCommunitiesTitle")}
              description={t("web.getStudents.noCommunitiesBody")}
              action={
                <Button asChild>
                  <Link href="/dashboard/get-students/communities">
                    {t("web.getStudents.addCommunity")}
                  </Link>
                </Button>
              }
            />
          ) : null}

          {hasCommunities && next ? (
            <section aria-labelledby="get-students-next" className="space-y-3">
              <Heading level={3} as="h2" id="get-students-next">
                {t("web.getStudents.nextTitle")}
              </Heading>
              <NextActionCard item={next} />
            </section>
          ) : null}

          {rest.length > 0 ? (
            <section aria-labelledby="get-students-rest" className="space-y-3">
              <Heading level={3} as="h2" id="get-students-rest">
                {t("web.getStudents.restTitle")}
              </Heading>
              <Card>
                <CardContent className="p-0">
                  <ul className="divide-y divide-border">
                    {rest.map((item) => (
                      <ActionRow key={item.id} item={item} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          ) : null}

          {/* She has finished the week. Say so, and hand her the one thing
              worth doing next — reading what any of it produced. */}
          {hasCommunities && progress.complete ? (
            <EmptyState
              icon={CheckCircle2}
              title={t("web.getStudents.allDoneTitle")}
              description={t("web.getStudents.allDone")}
              action={
                <Button asChild variant="outline">
                  <Link href="/dashboard/get-students/results">
                    {t("web.getStudents.seeAllResults")}
                  </Link>
                </Button>
              }
            />
          ) : null}

          {/* Nothing is outstanding and nothing counts as done: the planner
              produced no actions at all (every community inside its cooldown,
              or no content kind eligible for any of them), or she skipped the
              lot. `complete` needs a total above zero, so this can never
              collide with the congratulation above it. Both cases used to
              render a blank column. */}
          {hasCommunities && progress.total === 0 ? (
            <EmptyState
              title={t("web.getStudents.nothingPlannedTitle")}
              description={t("web.getStudents.nothingPlannedBody")}
              action={<RegeneratePlanButton />}
            />
          ) : null}

          {settled.length > 0 ? (
            <section aria-labelledby="get-students-done" className="space-y-3">
              <Heading level={3} as="h2" id="get-students-done">
                {t("web.getStudents.doneTitle")}
              </Heading>
              <Card>
                <CardContent className="p-0">
                  <ul className="divide-y divide-border">
                    {settled.map((item) => (
                      <DoneRow key={item.id} item={item} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          ) : null}
        </div>

        <aside className="space-y-6">
          {/* Not urgent: still worth doing, but it waits its turn beside the
              week's actions rather than competing with them. */}
          {readiness.isBottleneck ? null : (
            <PageReadinessCard readiness={readiness} slug={teacher.bookingSlug} />
          )}
          <ResultsSummaryCard headline={headline} />
        </aside>
      </div>
    </PageShell>
  );
}
