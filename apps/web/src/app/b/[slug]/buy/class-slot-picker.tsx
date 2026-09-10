"use client";

import { useEffect, useMemo, useState } from "react";
import { generateSlots } from "@/lib/slots";
import { firstAvailableDay } from "@/lib/booking/next-available";
import type { SlotInputsWire } from "@/lib/booking/slot-inputs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT, useLocale } from "@/components/locale-provider";
import { timeOptionsFor } from "@spiralclass/shared";

// Today's local date (YYYY-MM-DD) in the teacher's timezone — the booking
// window is anchored to her wall clock, not the visitor's.
function todayInZone(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Pre-payment slot picker. Generates the day's grid in the browser
// (generateSlots is pure) so the student can choose a time before paying, then
// reports the chosen UTC instant up to the checkout form via `onChange`. The
// server re-validates the slot when the payment lands (auto-book-on-paid), so
// this is a convenience surface, not the source of truth.
//
// Used by both offerings since D-111, and `optional` is the whole difference:
// for a single class the slot IS the reservation and checkout blocks without
// it; for a multi-class package this picks the FIRST class only, the rest are
// booked from the portal, and skipping it must stay a first-class path rather
// than something the student has to work out how to escape.
export function ClassSlotPicker({
  timezone,
  bufferMin,
  minAdvanceH,
  maxAdvanceDays,
  classDurationMin,
  inputs,
  value,
  onChange,
  optional = false,
}: {
  timezone: string;
  bufferMin: number;
  minAdvanceH: number;
  maxAdvanceDays: number;
  classDurationMin: number;
  inputs: SlotInputsWire;
  value: string | null;
  onChange: (iso: string | null) => void;
  optional?: boolean;
}) {
  const locale = useLocale();
  const t = useT();

  const todayYmd = useMemo(() => todayInZone(timezone), [timezone]);
  const maxYmd = useMemo(() => addDaysYmd(todayYmd, maxAdvanceDays), [todayYmd, maxAdvanceDays]);

  // Rehydrate the serialized instants once; generateSlots wants Date objects.
  const { blockedDates, existingBookings } = useMemo(
    () => ({
      blockedDates: inputs.blockedDates.map((b) => ({
        startsAt: new Date(b.startsAt),
        endsAt: new Date(b.endsAt),
      })),
      existingBookings: inputs.existingBookings.map((b) => ({
        scheduledStart: new Date(b.scheduledStart),
        scheduledEnd: new Date(b.scheduledEnd),
        bufferMinSnapshot: b.bufferMinSnapshot,
      })),
    }),
    [inputs],
  );

  // Land on the first day that actually has openings — same as the portal's
  // booking page (my-classes/book, via firstAvailableDay). Opening on "today"
  // unconditionally showed "No times available" before the student ever saw
  // a time, whenever today itself happened to be full. Computed once on
  // mount; changing the date afterward is the student's own choice.
  const [date, setDate] = useState(() => {
    const hasSlots = (d: string) =>
      generateSlots({
        date: d,
        classDurationMin,
        teacher: { timezone, bufferMin, minAdvanceH, maxAdvanceDays },
        availabilityRules: inputs.availabilityRules,
        blockedDates,
        existingBookings,
        now: new Date(),
      }).length > 0;
    return firstAvailableDay(todayYmd, maxYmd, hasSlots) ?? todayYmd;
  });

  const slots = useMemo(() => {
    if (date < todayYmd || date > maxYmd) return [];
    return generateSlots({
      date,
      classDurationMin,
      teacher: { timezone, bufferMin, minAdvanceH, maxAdvanceDays },
      availabilityRules: inputs.availabilityRules,
      blockedDates,
      existingBookings,
      now: new Date(),
    });
  }, [
    date,
    todayYmd,
    maxYmd,
    classDurationMin,
    timezone,
    bufferMin,
    minAdvanceH,
    maxAdvanceDays,
    inputs.availabilityRules,
    blockedDates,
    existingBookings,
  ]);

  // Whose clock the times are shown on.
  //
  // They used to be the TEACHER's, always, labelled "Times shown in your
  // teacher's zone (America/Mexico_City)" — which asks a buyer in London or
  // Chicago to do timezone arithmetic in the middle of a checkout, on a step
  // that is optional for a package and therefore free to abandon. The slot is
  // an instant either way (`startUtc`), so which zone it is RENDERED in is
  // presentation only and cannot change what gets booked.
  //
  // Resolved in an effect rather than during render: the server pass has no
  // visitor timezone, so reading it inline would make the first client render
  // disagree with the HTML and fail hydration. Starting at the teacher's zone
  // means the pre-hydration paint is the old behaviour, not a wrong one.
  const [viewerZone, setViewerZone] = useState<string | null>(null);
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== timezone) setViewerZone(tz);
  }, [timezone]);
  const displayZone = viewerZone ?? timezone;

  const fmtTime = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: displayZone,
      ...timeOptionsFor(locale),
    }).format(d);

  // The chosen day, spelled out. The native date input renders `01/09/2026`,
  // which is two different days depending on the reader's locale — and the
  // reader here is explicitly someone from somewhere else. Anchored at midday
  // UTC so the date can't slip a day when formatted.
  const longDate = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));

  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">
        {optional ? t("web.buyFlow.pickFirstClass") : t("buy.pickTime")}
      </legend>
      {optional && (
        <p className="text-muted-foreground text-xs">{t("web.buyFlow.pickFirstClassOptional")}</p>
      )}
      <div className="space-y-1">
        <Label htmlFor="class-slot-date">{t("book.chooseDate")}</Label>
        <Input
          id="class-slot-date"
          type="date"
          min={todayYmd}
          max={maxYmd}
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            onChange(null); // clear the chosen time when the day changes
          }}
        />
        <p className="text-foreground/80 text-xs font-medium">{longDate}</p>
        <p className="text-muted-foreground text-xs">
          {viewerZone
            ? t("web.buyFlow.timesInYourZone", {
                timezone: viewerZone,
                teacherTimezone: timezone,
              })
            : t("web.buyFlow.timesInTeacherZone", { timezone })}
        </p>
      </div>

      {slots.length === 0 ? (
        <p className="border-border/60 bg-muted/30 text-muted-foreground rounded-md border p-3 text-center text-sm">
          {t("web.buyFlow.noSlotsTryAnother")}
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 lg:grid-cols-4">
          {slots.map((s) => {
            const iso = s.startUtc.toISOString();
            const selected = value === iso;
            return (
              <li key={iso}>
                <button
                  type="button"
                  onClick={() => onChange(selected ? null : iso)}
                  aria-pressed={selected}
                  className={`w-full rounded-md border px-2 py-2 text-sm tabular-nums transition-colors ${
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "hover:bg-muted/40"
                  }`}
                >
                  {fmtTime(s.startUtc)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
