import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { initialsFrom } from "@/lib/initials";
import { rosterFlags, rosterNote, type RosterNote, type RosterStudent } from "@/lib/students-list";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The roster, as one continuous list.
 *
 * WHAT THIS REPLACES, and why each change is a change. Every row used to be a
 * flat run of same-sized text — name, email, then three to five chips and a
 * sentence, all at the supporting-text step — so nothing on it was more
 * important than anything else and the eye had no column to run down. The row
 * carried four facts and ranked none of them.
 *
 * Three decisions, each of which is a decision rather than a default:
 *
 *  1. THE BALANCE IS A FIGURE, in its own right-hand column, at the size and
 *     weight of a figure. "Package of 8 · 3 available" was a sentence, and the
 *     number a teacher opens this screen to read was the fourth word of it. It
 *     is `tabular-nums` so the column actually aligns.
 *  2. ONE NOTE PER ROW, not every true statement about it. See `rosterNote` —
 *     a row that says "expiring", "running low" AND "no class booked" has
 *     given three symptoms of one situation and left her to rank them.
 *  3. COLOUR IS NEVER THE ONLY CARRIER. A low balance shows as the number "1",
 *     not as a red row; an expiry shows as the words "Expires in 6 days", not
 *     as an amber dot. Tone reinforces what the text already says, which is
 *     also what makes the list legible to the ~8% of readers for whom the
 *     amber and the grey are the same colour.
 */
export function RosterList({
  students,
  now,
  timezone,
  t,
}: {
  students: RosterStudent[];
  now: Date;
  timezone: string;
  t: TFunction;
}) {
  return (
    <ul className="divide-border divide-y">
      {students.map((student) => (
        <li key={student.studentId}>
          <RosterRow student={student} now={now} timezone={timezone} t={t} />
        </li>
      ))}
    </ul>
  );
}

function RosterRow({
  student,
  now,
  timezone,
  t,
}: {
  student: RosterStudent;
  now: Date;
  timezone: string;
  t: TFunction;
}) {
  const flags = rosterFlags(student, now, timezone);
  const note = rosterNote(student, flags, now, timezone);
  const pkg = student.activePackage;

  return (
    <Link
      href={`/dashboard/students/${student.studentId}`}
      className={cn(
        "min-h-target hover:bg-muted/50 flex items-start gap-3 px-4 py-3 transition-colors lg:px-6",
        // Archived rows are de-emphasised by REMOVING colour, not by adding
        // transparency. The old `opacity-70` on the whole section multiplied
        // through the muted text underneath it and dropped it below AA — the
        // one thing a "de-emphasise" must not do is make text unreadable.
        student.archived && "grayscale",
      )}
    >
      {/* Decorative: the name is right beside it, and a screen reader
          announcing "AL" before it is noise, not information. */}
      <span
        aria-hidden
        className="bg-secondary text-secondary-foreground mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-medium select-none"
      >
        {initialsFrom(student.name, student.email)}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{student.name}</p>
        <p className="text-muted-foreground truncate text-sm">
          {student.email ?? student.phoneE164 ?? t("web.dashboard.students.noEmail")}
        </p>
        <RowChips student={student} note={note} t={t} />
      </div>

      <div className="flex shrink-0 items-start gap-1">
        <div className="text-right">
          {pkg ? (
            <>
              <p
                className={cn(
                  "text-lg font-semibold tabular-nums",
                  // `noPackage` is true HERE only when the package is spent —
                  // zero left, which is the most urgent balance there is and
                  // the one `lowBalance` deliberately excludes (see
                  // students-list.ts). Without it, "0 left" rendered in the
                  // same neutral ink as "8 left".
                  flags.expired
                    ? "text-destructive"
                    : flags.lowBalance || flags.noPackage
                      ? "text-warning"
                      : "text-foreground",
                )}
              >
                {/* Split so the eye gets "3 left" and a screen reader gets the
                    whole sentence — "of 8" on its own line below reads as a
                    fragment out of context. */}
                <span aria-hidden>
                  {t("web.dashboard.students.roster.left", { count: pkg.left })}
                </span>
                <span className="sr-only">
                  {t("web.dashboard.students.roster.balanceSr", {
                    count: pkg.left,
                    total: pkg.total,
                  })}
                </span>
              </p>
              <p aria-hidden className="text-subtle text-sm tabular-nums">
                {t("web.dashboard.students.roster.ofTotal", { total: pkg.total })}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.students.noActivePackage")}
            </p>
          )}
        </div>
        {/* The affordance that says the whole row opens something. Hidden from
            the accessibility tree — the link's own text is the label. */}
        <ChevronRight className="text-muted-foreground/50 mt-1.5 size-4 shrink-0" aria-hidden />
      </div>
    </Link>
  );
}

/**
 * The chips under the name: what is wrong first, then who this student is.
 *
 * Capped at three by construction — one note, one hold, one level — plus the
 * agreed-price count, which is the only one that is about money and the only
 * one a teacher ever looks for deliberately. A row with five chips is a row
 * with none, because nobody reads five.
 */
function RowChips({
  student,
  note,
  t,
}: {
  student: RosterStudent;
  note: RosterNote;
  t: TFunction;
}) {
  const chips: React.ReactNode[] = [];

  if (note) chips.push(<NoteBadge key="note" note={note} t={t} />);

  if (student.notLive) {
    chips.push(
      <Badge key="hold" variant="info">
        {t("web.dashboard.students.notLive")}
      </Badge>,
    );
  }

  if (student.levelLabel) {
    chips.push(
      <Badge key="level" variant="secondary">
        {student.levelLabel}
      </Badge>,
    );
  }

  if (student.agreedPriceCount > 0) {
    chips.push(
      <Badge key="prices" variant="clay">
        {t("web.dashboard.students.roster.agreedPrices", { count: student.agreedPriceCount })}
      </Badge>,
    );
  }

  if (chips.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</div>;
}

function NoteBadge({ note, t }: { note: NonNullable<RosterNote>; t: TFunction }) {
  if (note.kind === "expired") {
    return <Badge variant="destructive">{t("web.dashboard.students.roster.note.expired")}</Badge>;
  }
  if (note.kind === "expiringSoon") {
    return (
      <Badge variant="warning">
        {note.days === 0
          ? t("web.dashboard.students.roster.note.expiresToday")
          : t("web.dashboard.students.roster.note.expiresInDays", { count: note.days })}
      </Badge>
    );
  }
  return <Badge variant="outline">{t("web.dashboard.students.roster.note.unbooked")}</Badge>;
}
