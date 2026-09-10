import Link from "next/link";
import { CalendarPlus, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { initialsFrom } from "@/lib/initials";
import { formatZonedTime, timezoneCityLabel } from "@/lib/date-display";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import {
  STUDENT_TABS,
  STUDENT_TAB_LABEL_KEY,
  studentDetailHref,
  type StudentTab,
} from "./student-detail-nav";

/**
 * The chrome every view of a student shares: who they are, the four numbers
 * that decide what the teacher does next, and the way between the views.
 *
 * All three are synchronous on purpose. They take `t` rather than awaiting
 * `getT()` themselves, so the page can render them inside a tree that a test
 * (or any non-async parent) can render in one pass — the same reason
 * `lib/booking/status-display.ts` exists.
 */

/**
 * A monogram, not a photo: students have no avatar anywhere in this product,
 * and an empty circle in a page's first position is worse than a letter. It is
 * `aria-hidden` because it repeats the name printed immediately beside it.
 */
function StudentMonogram({ name, email }: { name: string; email: string | null }) {
  return (
    <span
      aria-hidden
      className="border-border bg-secondary text-secondary-foreground flex h-14 w-14 shrink-0 items-center justify-center rounded-full border text-lg font-semibold select-none"
    >
      {initialsFrom(name, email)}
    </span>
  );
}

export function StudentIdentity({
  studentId,
  name,
  email,
  phone,
  levelLabel,
  notLive,
  archived,
  studentTimezone,
  teacherTimezone,
  locale,
  now,
  t,
}: {
  studentId: string;
  name: string;
  email: string | null;
  phone: string | null;
  levelLabel: string | null;
  notLive: boolean;
  archived: boolean;
  studentTimezone: string | null;
  teacherTimezone: string;
  locale: AppLocale;
  now: Date;
  t: TFunction;
}) {
  // The same rule the class list follows: a second clock is printed only when
  // the two wall clocks actually disagree, so the one student in another zone
  // does not look like the twenty who are not.
  const otherZone = studentTimezone && studentTimezone !== teacherTimezone ? studentTimezone : null;

  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-4">
      <StudentMonogram name={name} email={email} />

      <div className="min-w-0 flex-1 basis-64 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Heading level={2} as="h1" className="min-w-0 break-words">
            {name}
          </Heading>
          {levelLabel && <Badge variant="secondary">{levelLabel}</Badge>}
          {notLive && <Badge variant="info">{t("web.dashboard.students.notLiveYet")}</Badge>}
          {archived && <Badge variant="warning">{t("web.dashboard.students.archivedBadge")}</Badge>}
        </div>

        {/* A definition list rather than a run of spans: these are labelled
            facts, and a screen reader announcing "Email, mira@…" beats
            announcing three unrelated fragments separated by interpuncts. The
            labels are visually hidden because the shapes (an @, a +, a clock)
            already say which is which to a sighted reader. */}
        <dl className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <div className="flex min-w-0 items-center gap-1.5">
            <dt className="sr-only">{t("web.dashboard.students.contact.emailLabel")}</dt>
            <dd className="min-w-0 truncate">
              {email ? (
                <a
                  href={`mailto:${email}`}
                  className="hover:text-foreground underline-offset-4 hover:underline"
                >
                  {email}
                </a>
              ) : (
                t("web.dashboard.students.noEmail")
              )}
            </dd>
          </div>
          {phone && (
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">{t("web.dashboard.students.contact.phone")}</dt>
              <dd>
                <a
                  href={`tel:${phone}`}
                  className="hover:text-foreground underline-offset-4 hover:underline"
                >
                  {phone}
                </a>
              </dd>
            </div>
          )}
          {otherZone && (
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">{t("web.dashboard.students.header.theirTimeLabel")}</dt>
              <dd>
                {t("web.dashboard.students.header.theirTime", {
                  time: formatZonedTime(now, otherZone, locale),
                  city: timezoneCityLabel(otherZone),
                })}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Booking is the action this page exists to lead to, so it is the only
          filled button on the screen. Messaging sits beside it because it is
          the other thing a teacher opens a student for; everything else is
          inside a tab. */}
      <div className="flex w-full shrink-0 flex-wrap gap-2 lg:w-auto">
        <Button asChild className="flex-1 lg:flex-none">
          <Link href={`/dashboard/classes/book?studentId=${studentId}`}>
            <CalendarPlus className="size-4" aria-hidden />
            {t("web.dashboard.students.bookClass")}
          </Link>
        </Button>
        <Button asChild variant="outline" className="flex-1 lg:flex-none">
          <Link href={`/dashboard/messages/${studentId}`}>
            <MessageSquare className="size-4" aria-hidden />
            {t("call.message")}
          </Link>
        </Button>
      </div>
    </header>
  );
}

/**
 * One number and the sentence that makes it mean something.
 *
 * `tabular-nums` so the four values line up as a row of figures rather than
 * four differently-kerned strings, and so a number that ticks down between
 * page loads does not shift the tile beside it.
 *
 * ON `text-2xl` RATHER THAN `text-h2`, here and on every title in this screen.
 * They are the same 22px — tailwind.config.ts redefines Tailwind's own keys
 * onto D-140's scale, and annotates each with the step it is. The stock key is
 * the one to reach for anywhere a class might be OVERRIDDEN, because `cn` is
 * tailwind-merge and tailwind-merge does not know the named steps: given
 * `text-2xl` from a primitive and `text-h3` from a caller it keeps both, and
 * Tailwind emits the stock utility last, so the override silently loses.
 */
function GlanceTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div className="bg-card space-y-1 px-4 py-4">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd
        className={cn("text-2xl font-semibold tabular-nums", tone === "warning" && "text-warning")}
      >
        {value}
      </dd>
      {hint ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
    </div>
  );
}

/**
 * The four questions a teacher opens a student for, answered before she has
 * chosen a tab: can she book, when is the next one, how much has been taught,
 * and how much has been paid.
 *
 * `gap-px` over a `bg-border` ground draws the hairlines between tiles without
 * a divide-utility that has to be undone at every breakpoint the grid rewraps
 * at.
 */
export function StudentGlance({
  classesLeft,
  activePackageCount,
  nextClassLabel,
  nextClassHint,
  classesTaught,
  classesTaughtHint,
  paidLabel,
  paidHint,
  t,
}: {
  classesLeft: number;
  activePackageCount: number;
  nextClassLabel: string;
  nextClassHint?: string;
  classesTaught: number;
  classesTaughtHint?: string;
  paidLabel: string;
  paidHint?: string;
  t: TFunction;
}) {
  return (
    <dl className="bg-border shadow-brand-sm grid grid-cols-2 gap-px overflow-hidden rounded-lg border lg:grid-cols-4">
      <GlanceTile
        label={t("web.dashboard.students.glance.classesLeft")}
        value={String(classesLeft)}
        hint={
          activePackageCount === 0
            ? t("web.dashboard.students.noActivePackage")
            : t("web.dashboard.students.glance.acrossPackages", {
                count: String(activePackageCount),
              })
        }
        // Zero classes left with no package to draw from is the one number on
        // this strip that is a prompt rather than a fact.
        tone={classesLeft === 0 ? "warning" : undefined}
      />
      <GlanceTile
        label={t("web.dashboard.students.glance.nextClass")}
        value={nextClassLabel}
        hint={nextClassHint}
      />
      <GlanceTile
        label={t("web.dashboard.students.glance.taught")}
        value={String(classesTaught)}
        hint={classesTaughtHint}
      />
      <GlanceTile
        label={t("web.dashboard.students.glance.paid")}
        value={paidLabel}
        hint={paidHint}
      />
    </dl>
  );
}

/**
 * The way between the five views.
 *
 * A `<nav>` of links with `aria-current`, NOT `role="tablist"`. The ARIA tab
 * pattern promises arrow-key traversal between panels that are already in the
 * document; these are page navigations, and claiming the role would tell a
 * screen-reader user to press keys that do nothing. Links that navigate are
 * described as links.
 */
export function StudentTabNav({
  studentId,
  active,
  t,
}: {
  studentId: string;
  active: StudentTab;
  t: TFunction;
}) {
  return (
    <nav aria-label={t("web.dashboard.students.tab.navLabel")} className="border-b">
      <ul className="-mb-px flex [scrollbar-width:none] gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden">
        {STUDENT_TABS.map((tab) => {
          const current = tab === active;
          return (
            <li key={tab}>
              <Link
                href={studentDetailHref(studentId, tab)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  // 44px of height, per D-140's target floor, and the underline
                  // rather than a pill so the row reads as one control strip
                  // sitting on the content it switches.
                  "focus-visible:ring-ring inline-flex min-h-11 items-center rounded-t-md border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:outline-hidden",
                  current
                    ? "border-primary text-foreground"
                    : "text-muted-foreground hover:border-border hover:text-foreground border-transparent",
                )}
              >
                {t(STUDENT_TAB_LABEL_KEY[tab])}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
