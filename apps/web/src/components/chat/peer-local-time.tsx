"use client";

import { useEffect, useState } from "react";
import { formatTimeInZone, type AppLocale } from "@spiralclass/shared";
import { useT } from "@/components/locale-provider";

/**
 * The other person's wall-clock time, under their name in the thread header.
 *
 * Teachers and students on this platform are in different countries by
 * default, and "is it a reasonable hour where they are?" is the question
 * behind most of the hesitation before sending a message. It is a small line
 * of text that answers it.
 *
 * The server renders the first value so the markup matches on hydration; the
 * interval only matters for a thread left open across a minute boundary.
 */
export function PeerLocalTime({
  initialTime,
  timeZone,
  locale,
}: {
  initialTime: string;
  timeZone: string;
  locale: AppLocale;
}) {
  const t = useT();
  const [time, setTime] = useState(initialTime);

  useEffect(() => {
    const tick = () => setTime(formatTimeInZone(new Date(), timeZone, locale));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timeZone, locale]);

  return <>{t("chat.thread.localTime", { time })}</>;
}
