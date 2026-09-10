import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BookingStatusBadge, MaterialsBadge } from "@/components/booking-status-badge";
import { getDualZoneTime } from "@/lib/date-display";
import { groupBookingsByDay } from "@/lib/booking-day-groups";
import { classProximity, proximityLabel } from "@/lib/classes-list";
import type { AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The teacher's roster, as one continuous sequence.
 *
 * WHAT THIS REPLACES, and why each change is a change. The list used to be a
 * stack of bordered cards inside a bordered card inside the page — three
 * levels of box for one level of information — and each card spent four lines
 * saying things the reader already knew:
 *
 *   - The DATE appeared three times per class: once in the day heading above
 *     it, once in the row's own "Mon, Aug 31, 10:00 AM", and once more in the
 *     second-timezone line. It appears once now, in the heading, which leaves
 *     the row's time column holding nothing but a time — so the times finally
 *     form a column the eye can run down. That column is `tabular-nums` for
 *     the same reason.
 *   - The SECOND TIMEZONE was printed on every row whether or not the two
 *     clocks differed, so the one booking where it mattered looked exactly
 *     like the twenty where it did not. It is now printed only when the wall
 *     clocks actually disagree — the rule the dashboard already followed.
 *   - The STATUS BADGE said "Scheduled" on every row of a list whose query
 *     filters for `status: "scheduled"`. Upcoming rows carry no status badge;
 *     past rows, where the status is the whole point, still do.
 *
 * What is left is name, time, package and — the one genuinely actionable
 * signal — whether the class has materials attached yet.
 */

/** Everything a row renders, already narrowed away from Prisma's shape. */
export type ClassListItem = {
  id: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: string;
  studentName: string;
  /** Null when the student never set one — the row then shows a single clock. */
  studentTimezone: string | null;
  packageName: string | null;
  durationMin: number | null;
  hasMaterials: boolean;
};

type ListContext = {
  locale: AppLocale;
  t: TFunction;
  /** The teacher's own zone. She is always the viewer on this screen. */
  timezone: string;
  now: Date;
};

/**
 * A day heading, sticky under the app bar.
 *
 * `top-14` is not a guess: the app header is `h-14` (see app-nav.tsx), and the
 * tablet sidebar already pins itself to the same number for the same reason.
 */
function DayHeading({
  label,
  emphasis,
  first,
}: {
  label: string;
  emphasis: boolean;
  /** The card's own top border and radius stand in for this one's. */
  first: boolean;
}) {
  return (
    // `h2`, because the list card carries no heading of its own — the toolbar
    // above it already names the view, and repeating "Upcoming" inside a card
    // that sits under an "Upcoming" tab said the word twice. The days are the
    // list's top-level structure, so they take the level.
    <h2
      className={cn(
        // An opaque ground, not a tint: a translucent sticky band lets the rows
        // it is meant to hide show through it as they pass underneath.
        "bg-muted text-muted-foreground sticky top-14 z-10 border-b px-4 py-2 text-sm font-medium lg:px-6",
        // The card cannot clip its children — `overflow-hidden` is what makes
        // a sticky descendant stop sticking — so the first band rounds its own
        // corners rather than square-cutting the card's.
        first ? "rounded-t-lg" : "border-t",
        // Today and tomorrow are the two days she is actually working in.
        emphasis && "text-foreground font-semibold",
      )}
    >
      {label}
    </h2>
  );
}

/**
 * One class.
 *
 * Deliberately no `aria-label`: one would REPLACE the row's content as the
 * link's accessible name, so a screen-reader user would hear "Open the class
 * with Marcela Rivera" and lose the time, the package and the materials
 * state — the things the row exists to say. The content is the better name.
 */
async function ClassRow({
  item,
  ctx,
  showStatus,
  showDate,
  showMaterials,
  featured,
}: {
  item: ClassListItem;
  ctx: ListContext;
  /** Past rows carry the outcome; upcoming rows are all `scheduled` and say so by being here. */
  showStatus: boolean;
  /** Rows outside a day group (the "just finished" strip) carry their own date. */
  showDate: boolean;
  /**
   * False on a class that has already been taught. `MaterialsBadge` keys its
   * "No materials" warning off `status`, and a just-finished class is still
   * `scheduled` until the sweep completes it — so without this it warns that
   * a lesson which already happened has nothing prepared for it.
   */
  showMaterials: boolean;
  featured?: boolean;
}) {
  const { t, locale, timezone, now } = ctx;
  const zoned = getDualZoneTime(
    item.scheduledStart,
    { tz: timezone, label: t("web.dualZone.yourTime") },
    { tz: item.studentTimezone ?? timezone, label: item.studentName },
    locale,
    now,
  );
  const proximity = classProximity(item.scheduledStart, item.scheduledEnd, now);
  const countdown = proximityLabel(proximity);
  const meta = [
    item.packageName,
    item.durationMin
      ? t("web.dashboard.home.schedule.durationMin", { count: item.durationMin })
      : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <Link
      href={`/dashboard/classes/${item.id}`}
      className="min-h-target hover:bg-muted/50 flex items-center gap-3 px-4 py-3 transition-colors lg:gap-4 lg:px-6"
    >
      {/* A fixed column so the times align, `whitespace-nowrap` rather than a
          hard truncate so a reader who has turned the text scale up gets a
          wider column instead of a clipped clock. */}
      <div className="w-24 shrink-0 whitespace-nowrap">
        {showDate && <div className="text-muted-foreground text-sm">{zoned.viewer.dateLabel}</div>}
        <div className={cn("font-semibold tabular-nums", featured && "text-lg")}>
          {zoned.viewer.timeLabel}
        </div>
      </div>

      {/* The chips reflow rather than being squeezed. At 390px this column is a
          COLUMN — text, then the chips underneath it — and only above `lg`,
          where there is room for both, does it become a row with the chips
          right-aligned. That right alignment is worth keeping on a wide screen:
          it is what turns "which of these still needs materials" into a single
          glance down one edge. On a phone the same arrangement left the name
          truncated at eight characters and the duration wrapped over three
          lines, which is a worse answer to every question the row is asked. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <div className="min-w-0">
          <div className={cn("truncate", featured ? "font-semibold" : "font-medium")}>
            {item.studentName}
          </div>
          {meta.length > 0 && (
            <div className="text-muted-foreground text-sm">
              {meta.map((part, i) => (
                <span key={part}>
                  {/* The separator is decoration, not part of what the row says. */}
                  {i > 0 && <span aria-hidden="true"> · </span>}
                  {part}
                </span>
              ))}
            </div>
          )}
          {/* Only when the two clocks genuinely differ. An identical second time
              on every row trains the eye to skip the one line where it matters. */}
          {!zoned.sameWallClock && (
            <div className="text-subtle text-sm">
              {t("web.dualZone.otherPartyTime", {
                name: zoned.other.label,
                time: `${zoned.other.timeLabel} (${zoned.other.tzDisplay})`,
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:justify-end">
          {/* Presence gets the solid brand fill — it is the one row on the
              page that is happening rather than scheduled. The countdown is
              deliberately quieter: it is information, not an alarm. */}
          {proximity.state === "live" && <Badge>{t("web.dashboard.classes.list.liveNow")}</Badge>}
          {countdown && <Badge variant="outline">{t(countdown.key, countdown.vars)}</Badge>}
          {showStatus && <BookingStatusBadge status={item.status} viewer="teacher" />}
          {showMaterials && (
            <MaterialsBadge hasMaterials={item.hasMaterials} status={item.status} />
          )}
        </div>
      </div>

      <ChevronRight className="text-muted-foreground size-5 shrink-0" aria-hidden />
    </Link>
  );
}

/**
 * The day-grouped list.
 *
 * One `<ul>` per day rather than one flat list of every class: a screen reader
 * announces "list, 3 items" per day, which is the count a sighted reader gets
 * from seeing the group, and the day heading above it is a real heading rather
 * than a row that happens to sit there.
 */
export function ClassList({
  items,
  ctx,
  showStatus = false,
  /** The soonest class is given a little more weight — it is the one being asked about. */
  featureFirst = false,
  /** False when something follows the list inside the card, and rounds its corners instead. */
  roundedBottom = true,
}: {
  items: ClassListItem[];
  ctx: ListContext;
  showStatus?: boolean;
  featureFirst?: boolean;
  roundedBottom?: boolean;
}) {
  const groups = groupBookingsByDay(items, ctx.timezone, ctx.locale, ctx.now, ctx.t);

  return (
    <div>
      {groups.map((group, index) => (
        // A plain div, not a <section>. A named section becomes a `region`
        // landmark, and thirty of them — one per day — would bury the handful
        // that actually orient someone. The heading is what a screen reader
        // user navigates this list by, and the <ul> is what tells them how many
        // classes the day holds.
        <div key={group.ymd}>
          <DayHeading label={group.label} emphasis={group.relative !== null} first={index === 0} />
          {/* `overflow-hidden` here and not on the card: it clips the last
              row's hover tint to the card's radius, and the sticky heading is
              this list's SIBLING, so nothing that sticks sits inside it. */}
          <ul
            className={cn(
              "divide-border divide-y",
              roundedBottom && index === groups.length - 1 && "overflow-hidden rounded-b-lg",
            )}
          >
            {group.items.map((item) => (
              <li key={item.id}>
                <ClassRow
                  item={item}
                  ctx={ctx}
                  showStatus={showStatus}
                  showDate={false}
                  showMaterials
                  featured={featureFirst && item.id === items[0]?.id}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * A short, flat list with no day grouping — used by the "just finished" strip,
 * where the rows are few, already ordered, and each carries its own date.
 */
export function FlatClassList({
  items,
  ctx,
  showStatus = false,
}: {
  items: ClassListItem[];
  ctx: ListContext;
  showStatus?: boolean;
}) {
  return (
    <ul className="divide-border divide-y overflow-hidden rounded-b-lg border-t">
      {items.map((item) => (
        <li key={item.id}>
          <ClassRow item={item} ctx={ctx} showStatus={showStatus} showDate showMaterials={false} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A recent outcome, in the aside.
 *
 * A separate, narrower row rather than `ClassRow` with a variant: the aside is
 * a third of the width and the question it answers is different ("what
 * happened?", not "when is it?"), so the status leads and the time is the
 * supporting detail. One component doing both would be a pile of conditionals.
 */
export function RecentRow({ item, ctx }: { item: ClassListItem; ctx: ListContext }) {
  const { t, locale, timezone, now } = ctx;
  const zoned = getDualZoneTime(
    item.scheduledStart,
    { tz: timezone, label: t("web.dualZone.yourTime") },
    { tz: item.studentTimezone ?? timezone, label: item.studentName },
    locale,
    now,
  );

  return (
    <Link
      href={`/dashboard/classes/${item.id}`}
      className="min-h-target hover:bg-muted/50 flex flex-col gap-1 px-4 py-3 transition-colors lg:px-6"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{item.studentName}</span>
        <BookingStatusBadge status={item.status} viewer="teacher" />
      </div>
      <span className="text-muted-foreground text-sm tabular-nums">
        {zoned.viewer.dateLabel}, {zoned.viewer.timeLabel}
      </span>
    </Link>
  );
}
