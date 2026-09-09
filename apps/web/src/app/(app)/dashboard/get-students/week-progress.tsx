import type { PlanProgress } from "@spiralclass/shared";
import { getT } from "@/lib/i18n";

/**
 * How far through the week she is.
 *
 * The screen used to say this in one grey line — "1 of 5 done · about 60 min
 * in total" — where the minutes were in fact the minutes REMAINING, and were
 * counted at a flat twelve per action even though the referral ask the planner
 * puts first is priced at five. Both halves are now `planProgress`, which is
 * pure and tested; this only renders it.
 *
 * The bar is the same instrument the growth checklist uses, deliberately: one
 * progress affordance in the product, not two that differ by which screen you
 * are on.
 */
export async function WeekProgress({ progress }: { progress: PlanProgress }) {
  const t = await getT();
  if (progress.total === 0) return null;

  const percent = Math.round(progress.fraction * 100);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium tabular-nums">
          {t("web.getStudents.progressDone", {
            done: progress.done,
            total: progress.total,
          })}
        </p>
        {progress.remaining > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("web.getStudents.minutesLeft", { minutes: progress.minutesLeft })}
          </p>
        ) : null}
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t("web.getStudents.weekProgressLabel")}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
