"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/components/locale-provider";
import { CopyFromLastClass, type LessonNoteRow } from "../[bookingId]/lesson-notes-panel";
import { PlanCueList } from "./plan-cue-list";

export type PlanClass = {
  bookingId: string;
  studentName: string;
  /** Already formatted in the teacher's zone by the server, e.g. "10:00 – 10:50". */
  timeRange: string;
  lastOfPackage: boolean;
  cues: LessonNoteRow[];
};

/**
 * One student's section of the day plan — the block under a name in her
 * notebook: who and when, the package flag when it applies, and her bullets.
 * The bullets are her private cues on that class, so they are the same list the
 * class page and the live call show.
 */
export function PlanClassCard({ item }: { item: PlanClass }) {
  const t = useT();
  // A named region per class, so a screen reader can jump student to student
  // the way the eye does down a notebook page.
  return (
    <Card role="region" aria-label={`${item.studentName}, ${item.timeRange}`}>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-lg" as="h2">
            <Link href={`/dashboard/classes/${item.bookingId}`} className="hover:underline">
              {item.studentName}
            </Link>{" "}
            <span className="text-sm font-normal text-muted-foreground">{item.timeRange}</span>
          </CardTitle>
          <CopyFromLastClass bookingId={item.bookingId} from="plan" t={t} />
        </div>
        {item.lastOfPackage && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary">{t("web.dashboard.classes.plan.lastOfPackage")}</Badge>
            {t("web.dashboard.classes.plan.lastOfPackageHelp")}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <PlanCueList bookingId={item.bookingId} studentName={item.studentName} cues={item.cues} />
      </CardContent>
    </Card>
  );
}
