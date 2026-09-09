// The one place a booking status becomes a colour on the calendar.
//
// It was two places — a `{dot, chip}` map in calendar-month.tsx and a separate
// block map in time-grid.tsx — which is how the month grid and the week grid
// came to disagree about `canceled_by_teacher` (a grey chip in one, a grey
// block with a *border* colour in the other) and how the legend ended up
// listing four of the six statuses.
//
// Every value is a semantic token pair (`--x-bg` behind `--x`), never an
// opacity over an unknown surface: those grounds are the ones the palette
// contrast test actually measures, and a `bg-success/15` composited against
// whichever surface it lands on is the exact defect the `*-bg` tokens were
// added to remove.

export const CALENDAR_STATUSES = [
  "scheduled",
  "completed",
  "no_show",
  "canceled_by_student",
  "canceled_by_teacher",
  "rescheduled",
] as const;

export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** The four statuses the legend names. The other two (`rescheduled`,
 * `canceled_by_teacher`) are rare enough that listing all six turns a key into
 * a wall — they still get their own colour, and every one of them is spelled
 * out in words on the agenda row and in each cell's accessible name. */
export const LEGEND_STATUSES = [
  "scheduled",
  "completed",
  "no_show",
  "canceled_by_student",
] as const;

type StatusStyle = {
  /** The density marker in a phone-width month cell. */
  dot: string;
  /** The labelled pill in a desktop month cell and on an agenda row. */
  chip: string;
  /** The positioned block in the week/day time grid. */
  block: string;
};

const STYLES: Record<CalendarStatus, StatusStyle> = {
  scheduled: {
    dot: "bg-info",
    chip: "bg-info-bg text-info",
    block: "border-info/50 bg-info-bg text-info",
  },
  completed: {
    dot: "bg-success",
    chip: "bg-success-bg text-success",
    block: "border-success/50 bg-success-bg text-success",
  },
  no_show: {
    dot: "bg-destructive",
    chip: "bg-destructive-bg text-destructive",
    block: "border-destructive/50 bg-destructive-bg text-destructive",
  },
  canceled_by_student: {
    dot: "bg-warning",
    chip: "bg-warning-bg text-warning",
    block: "border-warning/50 bg-warning-bg text-warning",
  },
  canceled_by_teacher: {
    dot: "bg-muted-foreground",
    chip: "bg-muted text-muted-foreground",
    block: "border-border bg-muted text-muted-foreground",
  },
  rescheduled: {
    dot: "bg-clay",
    chip: "bg-clay-bg text-clay",
    block: "border-clay/50 bg-clay-bg text-clay",
  },
};

const UNKNOWN: StatusStyle = {
  dot: "bg-muted-foreground",
  chip: "bg-muted text-muted-foreground",
  block: "border-border bg-muted text-muted-foreground",
};

/** `Booking.status` is a string column, so an unrecognised value is possible
 * and must render as something neutral rather than as nothing. */
export function styleFor(status: string): StatusStyle {
  return STYLES[status as CalendarStatus] ?? UNKNOWN;
}

/** A cancelled class is still on the calendar — the teacher needs to see that
 * the slot was given up — but it should not compete with the ones she is
 * actually teaching. */
export function isMuted(status: string): boolean {
  return status === "canceled_by_student" || status === "canceled_by_teacher";
}
