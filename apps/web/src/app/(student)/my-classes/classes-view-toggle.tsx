import Link from "next/link";
import type { getT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Product issue #3 — students with many bookings were staying on the flat
// list and rarely finding the calendar. Previously the only calendar entry
// points were a single outlined button on the list page and a nav link; this
// segmented List/Calendar toggle sits at the top of BOTH screens so switching
// is always a one-tap, always-visible affordance, not something to go hunting
// for. `?ref=list_toggle` on the calendar link feeds calendar_viewed's
// entry_point property (see calendar/page.tsx) so discoverability is
// measurable over time.
export function ClassesViewToggle({
  active,
  t,
}: {
  active: "list" | "calendar";
  t: Awaited<ReturnType<typeof getT>>;
}) {
  const tabClass = (isActive: boolean) =>
    cn(
      "rounded px-3 py-1.5 text-sm font-medium transition-colors",
      isActive
        ? "bg-background shadow-xs text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="flex shrink-0 rounded-md border p-0.5" role="group">
      <Link href="/my-classes" className={tabClass(active === "list")}>
        {t("web.studentCalendar.listView")}
      </Link>
      <Link href="/my-classes/calendar?ref=list_toggle" className={tabClass(active === "calendar")}>
        {t("calendar.viewCta")}
      </Link>
    </div>
  );
}
