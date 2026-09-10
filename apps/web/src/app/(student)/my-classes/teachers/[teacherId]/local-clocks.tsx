"use client";

import { useEffect, useState } from "react";
import { zoneNow, type ZoneNow } from "@/lib/date-display";

export type ClockParty = {
  /** Whose clock this is: the teacher's name, or "Your local time". */
  label: string;
  tz: string;
  /** The server's render of this clock — see the note on hydration below. */
  initial: ZoneNow;
};

/**
 * "Is it a reasonable hour where she is?" — the question a student asks in the
 * half-second before deciding whether to send a message, and the one this
 * profile used to answer with the literal string `America/Mexico_City`.
 *
 * Two live clocks rather than an offset ("3 hours ahead"), for three reasons:
 * an offset has to be pluralised, and half-hour zones exist (Kolkata,
 * Kathmandu, St John's); the calendar date can differ, which no offset phrase
 * carries; and two clock faces are read at a glance in any language.
 *
 * CLIENT, because a server-rendered clock is wrong the moment it arrives and
 * stays wrong for as long as the tab is open. The first paint uses each
 * party's `initial` verbatim so hydration matches the server byte for byte;
 * the effect then takes over.
 */
export function LocalClocks({ parties, locale }: { parties: ClockParty[]; locale: string }) {
  const [clocks, setClocks] = useState<ZoneNow[]>(() => parties.map((p) => p.initial));

  useEffect(() => {
    const tick = () => setClocks(parties.map((p) => zoneNow(new Date(), p.tz, locale)));
    tick();
    // Every 20s rather than aligned to the minute boundary: an aligned timer
    // drifts under background-tab throttling and lands its update late, which
    // is precisely when someone comes back to the tab and reads it.
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, [parties, locale]);

  // Derived rather than passed in, so it stays true when one of the two zones
  // rolls past midnight while the page is open.
  const differentDays = clocks.length > 1 && clocks.some((c) => c.ymd !== clocks[0].ymd);

  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {parties.map((party, i) => {
        const clock = clocks[i] ?? party.initial;
        return (
          <div key={`${party.label}-${party.tz}`} className="min-w-0">
            <dt className="text-muted-foreground truncate text-sm">{party.label}</dt>
            <dd className="mt-1">
              {/* Tabular figures, so the minute ticking over cannot shuffle the
                  line under a reader who is looking at something else. */}
              <span className="text-h2 font-semibold tabular-nums">{clock.time}</span>
              <span className="text-muted-foreground mt-0.5 block truncate text-sm">
                {differentDays ? `${clock.date} · ${clock.city}` : clock.city}
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
