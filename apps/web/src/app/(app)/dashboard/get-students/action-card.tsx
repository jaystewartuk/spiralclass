"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Clock3, Minus } from "lucide-react";
import {
  contentKindLabel,
  contentKindSummary,
  estimatedMinutesFor,
  planReasonText,
  platformLabel,
  type MarketingContentKind,
  type MarketingPlatform,
  type PlanActivityStatus,
  type PlanReason,
} from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { FormStatus } from "@/components/ui/form-status";
import { useLocale, useT } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";
import {
  markActivityDoneAction,
  skipActivityAction,
  type MarketingState,
} from "@/app/actions/marketing";

// One prepared action, in the three weights the week's list needs.
//
// WHY THREE COMPONENTS AND NOT ONE `<ActionCard>`. The screen used to render
// every action — the one she should do now, the four after it, and the three
// she already finished — as the same card, distinguished only by
// `opacity-60`. So nothing on the page was the answer to "what now", and the
// finished work carried the same visual weight as the work outstanding while
// having its text contrast quietly cut below the floor D-140 sets.
//
//   `NextActionCard` — the single next action, given hero weight and full
//                      controls. It leads with the REASON, because the reason
//                      is what turns a chore into advice: "Oaxaca Expats has
//                      already brought you 2 students" is the sentence that
//                      gets a post written.
//   `ActionRow`      — the rest of the week, as a scannable divided list. Here
//                      the TASK leads and the reason is the supporting line:
//                      scanning a list is a different act from being persuaded
//                      by one thing, and the same order does not serve both.
//   `DoneRow`        — settled work, quiet, carrying the one number that
//                      matters. It used to print `3 · 1 · 0` with no labels at
//                      all, which is not a result, it is a puzzle.

export type ActionCardItem = {
  id: string;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  status: PlanActivityStatus;
  reason: PlanReason | null;
  communityName: string | null;
  studentName: string | null;
  results: { visits: number; enquiries: number; students: number };
};

function useActivityActions() {
  const [doneState, doneAction, donePending] = useActionState<MarketingState, FormData>(
    markActivityDoneAction,
    undefined,
  );
  const [skipState, skipAction, skipPending] = useActionState<MarketingState, FormData>(
    skipActivityAction,
    undefined,
  );
  return { doneState, doneAction, donePending, skipState, skipAction, skipPending };
}

/**
 * What a finished action actually produced, as a sentence.
 *
 * Deliberately ONE number, the furthest down the funnel that is non-zero: a
 * teacher reading her week wants to know whether a post worked, and "brought
 * you a student" answers that where three bare counts do not. The full three
 * are still a click away on the action's own page, which is where a teacher
 * who wants to compare goes.
 */
function resultText(t: TFunction, results: ActionCardItem["results"]): string {
  if (results.students > 0) {
    return t("web.getStudents.resultStudents", { count: results.students });
  }
  if (results.enquiries > 0) {
    return t("web.getStudents.resultEnquiries", { count: results.enquiries });
  }
  if (results.visits > 0) return t("web.getStudents.resultVisits", { count: results.visits });
  return t("web.getStudents.resultNone");
}

/** Community, student, or — when the action belongs to neither — the platform. */
function whereFor(item: ActionCardItem, locale: ReturnType<typeof useLocale>): string {
  return item.communityName ?? item.studentName ?? platformLabel(item.platform, locale);
}

/** The one action she should do next, with everything she needs to decide. */
export function NextActionCard({ item }: { item: ActionCardItem }) {
  const t = useT();
  const locale = useLocale();
  const { doneState, doneAction, donePending, skipState, skipAction, skipPending } =
    useActivityActions();

  const task = contentKindLabel(item.kind, locale);
  const reason = item.reason ? planReasonText(item.reason, locale) : null;
  const where = whereFor(item, locale);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{where}</Badge>
          {item.status === "ready" && <Badge variant="success">{t("web.getStudents.ready")}</Badge>}
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Clock3 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("web.getStudents.aboutMinutes", { minutes: estimatedMinutesFor(item.kind) })}
          </span>
        </div>

        {/* The reason is the heading when there is one — see the note at the
            top of this file. `max-w-reading` keeps the measure inside D-140's
            cap even though the card itself is two thirds of a wide screen. */}
        <div className="max-w-reading space-y-1">
          <Heading level={3}>{reason ?? task}</Heading>
          {reason ? <p className="font-medium">{task}</p> : null}
          <p className="text-sm text-muted-foreground">{contentKindSummary(item.kind, locale)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/dashboard/get-students/${item.id}`}>
              {item.status === "planned"
                ? t("web.getStudents.prepare")
                : t("web.getStudents.viewAction")}
            </Link>
          </Button>
          <form action={doneAction}>
            <input type="hidden" name="id" value={item.id} />
            <Button type="submit" variant="outline" disabled={donePending}>
              {t("web.getStudents.markDone")}
            </Button>
          </form>
          <form action={skipAction}>
            <input type="hidden" name="id" value={item.id} />
            <Button type="submit" variant="ghost" disabled={skipPending}>
              {t("web.getStudents.skipThis")}
            </Button>
          </form>
        </div>

        {/* Only ever renders an error: no `savedMessage` is passed, because a
            success revalidates the page and moves this action into the
            finished list — a "Saved" line on a card that is about to vanish
            says nothing. A FAILURE used to vanish too, which is the bug. */}
        <FormStatus state={doneState} />
        <FormStatus state={skipState} />
      </CardContent>
    </Card>
  );
}

/**
 * One outstanding action in the week's list.
 *
 * The row's body is a link and the tick is a sibling button, never nested:
 * a button inside an anchor is invalid HTML, and the two are genuinely
 * different destinations — "show me this" and "I already did this".
 *
 * Skip does NOT appear here. Three controls per row is a wall, and skipping is
 * a decision worth seeing the prepared post before making; it lives on the
 * action's own page next to Mark as done.
 */
export function ActionRow({ item }: { item: ActionCardItem }) {
  const t = useT();
  const locale = useLocale();
  const { doneState, doneAction, donePending } = useActivityActions();

  const task = contentKindLabel(item.kind, locale);
  const reason = item.reason ? planReasonText(item.reason, locale) : null;

  return (
    <li>
      <div className="flex items-stretch">
        <Link
          href={`/dashboard/get-students/${item.id}`}
          className="flex min-h-target min-w-0 flex-1 items-center gap-3 py-3 pl-6 pr-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{task}</span>
              <Badge variant="outline">{whereFor(item, locale)}</Badge>
              {item.status === "ready" && (
                <Badge variant="success">{t("web.getStudents.ready")}</Badge>
              )}
            </span>
            <span className="block text-sm text-muted-foreground">
              {reason ?? contentKindSummary(item.kind, locale)}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
        <form action={doneAction} className="flex items-center pr-4">
          <input type="hidden" name="id" value={item.id} />
          {/* Named for the action it completes: a column of buttons all called
              "Mark as done" tells a screen-reader user which row they are in
              exactly as well as a column of buttons called "Fix" did. */}
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            disabled={donePending}
            aria-label={t("web.getStudents.markDoneNamed", { action: task })}
          >
            <Check className="h-5 w-5" aria-hidden="true" />
          </Button>
        </form>
      </div>
      <FormStatus state={doneState} className="px-6 pb-3" />
    </li>
  );
}

/** A finished or skipped action: quiet, and carrying what it produced. */
export function DoneRow({ item }: { item: ActionCardItem }) {
  const t = useT();
  const locale = useLocale();
  const done = item.status === "done";

  return (
    <li>
      <Link
        href={`/dashboard/get-students/${item.id}`}
        className="flex min-h-target flex-wrap items-center justify-between gap-x-3 gap-y-1 px-6 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          {/* Decoration beside a word that already says it — D-140: never state
              a status in a mark alone. A tick on a SKIPPED row would say the
              opposite of the badge next to it, so skipped gets a dash. */}
          {done ? (
            <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <Minus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate text-muted-foreground">
            {contentKindLabel(item.kind, locale)}
          </span>
          <Badge variant={done ? "success" : "outline"}>
            {done ? t("web.getStudents.done") : t("web.getStudents.skipped")}
          </Badge>
        </span>
        {done ? (
          <span className="text-sm text-muted-foreground">{resultText(t, item.results)}</span>
        ) : null}
      </Link>
    </li>
  );
}
