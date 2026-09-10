"use client";

import { useActionState, useState } from "react";
import { PlusCircle, Trash2 } from "lucide-react";
import { availabilitySchema, zodFieldErrors } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { HelpTip } from "@/components/help-tip";
import { useFieldErrors } from "@/hooks/use-field-errors";
import {
  nextRangeDefaults,
  rangesForDay,
  replaceDayRanges,
  type AvailabilityRange,
} from "@/lib/availability-ranges";
import { saveAvailabilityAction, type OnboardingState } from "@/app/actions/onboarding";
import { STARTER_AVAILABILITY } from "@/lib/starter-templates";
import { useT, useLocale } from "@/components/locale-provider";
import type { StringKey } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

type Range = AvailabilityRange;

// Mon-first display order (weekday values: 1..6, then Sunday = 0).
const WEEKDAYS: Array<{ value: number; labelKey: StringKey }> = [
  { value: 1, labelKey: "web.onboarding.availability.weekday.mon" },
  { value: 2, labelKey: "web.onboarding.availability.weekday.tue" },
  { value: 3, labelKey: "web.onboarding.availability.weekday.wed" },
  { value: 4, labelKey: "web.onboarding.availability.weekday.thu" },
  { value: 5, labelKey: "web.onboarding.availability.weekday.fri" },
  { value: 6, labelKey: "web.onboarding.availability.weekday.sat" },
  { value: 0, labelKey: "web.onboarding.availability.weekday.sun" },
];

// The values a new teacher gets prefilled during onboarding, applied only when
// they have no saved ranges yet. This is the single source of truth shared with
// the server-side seed (STARTER_AVAILABILITY), so the previewed default and the
// rows seeded for a teacher who skips this step can never drift apart.
const DEFAULT_RANGES: Range[] = STARTER_AVAILABILITY;

export function AvailabilityForm({
  initial,
  redirectTo,
  submitLabel,
}: {
  initial: {
    bufferMin: number;
    minAdvanceH: number;
    maxAdvanceDays: number;
    ranges: Range[];
  };
  redirectTo?: "/settings/availability";
  submitLabel?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const { errors, setErrors, clearError } = useFieldErrors<
    "bufferMin" | "minAdvanceH" | "maxAdvanceDays" | "ranges"
  >();
  const [ranges, setRanges] = useState<Range[]>(
    initial.ranges.length > 0 ? initial.ranges : DEFAULT_RANGES,
  );
  const [state, formAction, pending] = useActionState<OnboardingState, FormData>(
    saveAvailabilityAction,
    undefined,
  );

  const setDayRanges = (weekday: number, next: Range[]) => {
    setRanges((r) => replaceDayRanges(r, weekday, next));
    clearError("ranges");
  };

  // Client-side pre-validation against the same schema the action enforces, so
  // an overlapping window or an end-before-start lands the instant she submits
  // rather than after a round-trip. Nested range issues collapse to the single
  // "ranges" key (see zodFieldErrors), matching the days-section error slot.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const parsed = availabilitySchema(locale).safeParse({
      bufferMin: data.get("bufferMin"),
      minAdvanceH: data.get("minAdvanceH"),
      maxAdvanceDays: data.get("maxAdvanceDays"),
      ranges,
    });
    if (!parsed.success) {
      event.preventDefault();
      setErrors(zodFieldErrors(parsed.error));
    }
  }

  // Which control the server error points at, so we redden the right field
  // instead of always the first numeric input. "ranges" surfaces the error in
  // the days section rather than on a numeric field it has nothing to do with.
  const errorField = state?.field;
  const rangesError =
    errors.ranges ?? (state?.error && errorField === "ranges" ? state.error : undefined);

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-8">
      {redirectTo && <input type="hidden" name="redirectTo" value={redirectTo} />}
      <section className="space-y-3">
        <h2 className="font-medium">{t("web.onboarding.availability.editDaysHours")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("web.onboarding.availability.editDaysHoursHint")}
        </p>
        {rangesError && (
          <p
            id="availability-error"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {rangesError}
          </p>
        )}
        <div className="space-y-4">
          {WEEKDAYS.map((day) => (
            <DayRow
              key={day.value}
              weekday={day.value}
              label={t(day.labelKey)}
              ranges={rangesForDay(ranges, day.value)}
              onChange={(next) => setDayRanges(day.value, next)}
            />
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="bufferMin">{t("onboarding.availability.buffer")}</Label>
            <HelpTip
              label={t("web.onboarding.availability.bufferHelpLabel")}
              text={t("web.onboarding.availability.bufferHelpText")}
            />
          </div>
          <Input
            id="bufferMin"
            name="bufferMin"
            type="number"
            defaultValue={initial.bufferMin}
            min={0}
            max={120}
            required
            onChange={() => clearError("bufferMin")}
            invalid={Boolean(errors.bufferMin) || errorField === "bufferMin"}
            aria-describedby={
              errors.bufferMin || errorField === "bufferMin" ? "availability-error" : undefined
            }
          />
          <FieldError id="bufferMin-error" message={errors.bufferMin} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="minAdvanceH">{t("onboarding.availability.minNotice")}</Label>
            <HelpTip
              label={t("web.onboarding.availability.minNoticeHelpLabel")}
              text={t("web.onboarding.availability.minNoticeHelpText")}
            />
          </div>
          <Input
            id="minAdvanceH"
            name="minAdvanceH"
            type="number"
            defaultValue={initial.minAdvanceH}
            min={0}
            max={168}
            required
            onChange={() => clearError("minAdvanceH")}
            invalid={Boolean(errors.minAdvanceH) || errorField === "minAdvanceH"}
            aria-describedby={
              errors.minAdvanceH || errorField === "minAdvanceH" ? "availability-error" : undefined
            }
          />
          <FieldError id="minAdvanceH-error" message={errors.minAdvanceH} />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="maxAdvanceDays">{t("onboarding.availability.maxAdvance")}</Label>
            <HelpTip
              label={t("web.onboarding.availability.maxAdvanceHelpLabel")}
              text={t("web.onboarding.availability.maxAdvanceHelpText")}
            />
          </div>
          <Input
            id="maxAdvanceDays"
            name="maxAdvanceDays"
            type="number"
            defaultValue={initial.maxAdvanceDays}
            min={1}
            max={365}
            required
            onChange={() => clearError("maxAdvanceDays")}
            invalid={Boolean(errors.maxAdvanceDays) || errorField === "maxAdvanceDays"}
            aria-describedby={
              errors.maxAdvanceDays || errorField === "maxAdvanceDays"
                ? "availability-error"
                : undefined
            }
          />
          <FieldError id="maxAdvanceDays-error" message={errors.maxAdvanceDays} />
        </div>
      </section>

      {/* Range errors render up in the days section; everything else (numeric
          fields, generic fallback) shows here next to the submit button. */}
      {state?.error && !rangesError && (
        <p
          id="availability-error"
          role="alert"
          aria-live="polite"
          className="text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? t("web.onboarding.saving") : (submitLabel ?? t("common.continue"))}
      </Button>
    </form>
  );
}

function DayRow({
  weekday,
  label,
  ranges,
  onChange,
}: {
  weekday: number;
  label: string;
  ranges: Range[];
  onChange: (next: Range[]) => void;
}) {
  const t = useT();
  const enabled = ranges.length > 0;

  const toggle = () => {
    // Enable with a sensible default day; disable by clearing all its ranges.
    onChange(enabled ? [] : [{ weekday, startTime: "10:00", endTime: "18:00" }]);
  };

  const updateRange = (index: number, patch: Partial<Range>) => {
    onChange(ranges.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeRange = (index: number) => {
    onChange(ranges.filter((_, i) => i !== index));
  };

  const defaults = nextRangeDefaults(ranges);
  const addRange = () => {
    if (!defaults) return;
    onChange([...ranges, { weekday, ...defaults }]);
  };

  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={enabled}
        className={cn(
          "flex h-11 w-16 shrink-0 items-center justify-center rounded-md border text-sm font-medium transition-colors lg:h-10",
          enabled
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-foreground hover:bg-accent",
        )}
      >
        {label}
      </button>
      {enabled ? (
        <div className="flex-1 space-y-2">
          {ranges.map((range, index) => (
            <div key={index} className="flex items-center gap-2">
              {/* Weekday travels with every range so the parallel range_weekday
                  / range_start / range_end arrays the action reads stay aligned. */}
              <input type="hidden" name="range_weekday" value={weekday} />
              <Input
                type="time"
                name="range_start"
                aria-label={`${label} · ${t("web.onboarding.availability.startTime")}`}
                value={range.startTime}
                onChange={(e) => updateRange(index, { startTime: e.target.value })}
                className="w-full lg:w-32"
                required
              />
              <span className="text-muted-foreground" aria-hidden>
                –
              </span>
              <Input
                type="time"
                name="range_end"
                aria-label={`${label} · ${t("web.onboarding.availability.endTime")}`}
                value={range.endTime}
                onChange={(e) => updateRange(index, { endTime: e.target.value })}
                className="w-full lg:w-32"
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeRange(index)}
                aria-label={`${label} · ${t("web.onboarding.availability.removeTimeRange")}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          {defaults && (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={addRange}
              className="h-auto gap-1.5 px-0 text-primary no-underline hover:no-underline"
            >
              <PlusCircle className="h-4 w-4" />
              {t("web.onboarding.availability.addTimeRange")}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex h-11 flex-1 items-center lg:h-10">
          <Button type="button" variant="ghost" size="sm" onClick={toggle} className="px-0">
            {t("web.onboarding.availability.enable")}
          </Button>
        </div>
      )}
    </div>
  );
}
