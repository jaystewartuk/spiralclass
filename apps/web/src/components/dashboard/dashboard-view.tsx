import Link from "next/link";
import type { ComponentProps } from "react";
import { CalendarDays, CheckCircle2, ChevronRight } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Heading } from "@/components/ui/heading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getT } from "@/lib/i18n";
import { getDualZoneTime, formatZonedDate, timezoneCityLabel } from "@/lib/date-display";
import { SafeToSpendTile } from "@/components/cashflow-summary";
import { CopyLinkButton } from "@/components/copy-link-button";
import { GrowthChecklist } from "@/components/growth-checklist";
import type { MarketplaceSignalKey } from "@spiralclass/shared";
import { webNavLinks, type WebNavLink } from "@/lib/nav";
import { navIcon } from "@/lib/nav-icons";

/**
 * The dashboard's presentation, separated from its data (D-142).
 *
 * WHY THIS IS SPLIT OUT. Two callers need the same screen from different
 * sources: /dashboard builds this model from the signed-in teacher's rows, and
 * /demo builds it from a fixture so a stranger can see the real dashboard
 * without an account. The alternative — a second hand-built "demo dashboard" —
 * is a copy that drifts from the real one within a week, which would make the
 * demo actively misleading rather than merely stale.
 *
 * So this file owns every layout and copy decision, and knows nothing about
 * Prisma, auth or analytics. Anything a page must DO rather than SHOW (the
 * dashboard_viewed event, the cash-flow query) stays in the page, which is why
 * the demo cannot accidentally emit a real teacher's telemetry.
 *
 * The prop types are borrowed from the components they feed
 * (ComponentProps<typeof …>) rather than re-declared, so this file does not
 * import the server-only modules that compute them.
 *
 * ## The layout, and why it is shaped this way
 *
 * This screen was a single column of five equally-weighted cards, and its top
 * card was a URL to copy — a task performed about once a month. On a scheduling
 * product, the questions a teacher actually arrives with are "what is on
 * today?", "who is next?" and "how am I doing?", and the page could answer none
 * of them: it held no temporal information at all. So:
 *
 *   1. THE SCHEDULE LEADS. `<UpcomingClasses>` is the first thing under the
 *      greeting and the only element given hero weight.
 *   2. TWO COLUMNS ABOVE lg. The work she does (schedule, growth) sits in a
 *      two-thirds main column; the standing facts she checks (money, her link,
 *      payment status) sit in a one-third aside. Under lg they stack in that
 *      same priority order, which is why the aside is written after the main
 *      column rather than positioned with CSS.
 *   3. THE SHORTCUT GRID IS DEMOTED. "Day to day" is a third copy of an IA
 *      already in the header bar, the tablet sidebar and the account menu. It
 *      keeps its place (it is customizable, and it is how a teacher reaches the
 *      long tail) but it is a plain section at the foot of the page rather than
 *      the largest card on it.
 *
 * The one inversion: a teacher with no activity yet has no schedule to lead
 * with, and sharing her link IS her job — so for her the booking-link card
 * moves into the main column. See `linkLeads` below.
 */

/** One upcoming class, already narrowed to what the row renders. */
export type DashboardUpcomingClass = {
  id: string;
  scheduledStart: Date;
  studentName: string;
  /** Null when the student never set one — the row then shows a single clock. */
  studentTimezone: string | null;
  /** The package template's name ("Conversation", …), when the class has one. */
  packageName: string | null;
  durationMin: number | null;
};

export type DashboardViewModel = {
  teacherName: string;
  timezone: string;
  bookingSlug: string;
  bookingUrl: string;
  locale: ComponentProps<typeof GrowthChecklist>["locale"];
  /**
   * The instant the screen is rendered against. An explicit prop rather than a
   * `new Date()` inside this component, because /demo has to pin it: "Today"
   * and "4:00 PM" are computed on the SERVER, where Playwright's
   * `clock.setFixedTime` cannot reach, so a live clock here would make the
   * demo's committed visual baseline fail every day at midnight.
   */
  now: Date;
  hasNoActivityYet: boolean;
  marketplaceReady: boolean;
  missingSignals: MarketplaceSignalKey[];
  stripeConnected: boolean;
  transferConnected: boolean;
  stripeAvailable: boolean;
  growth: ComponentProps<typeof GrowthChecklist>["checklist"];
  cashFlow: ComponentProps<typeof SafeToSpendTile>["cashFlow"] | null;
  /** The soonest scheduled classes, ascending, plus the week's total. */
  schedule: { upcoming: DashboardUpcomingClass[]; weekAhead: number };
  visibleTileKeys: Parameters<typeof webNavLinks>[0];
  newLeadCount: number;
  /**
   * Demo mode. Every navigation renders inert, because the failure this
   * prevents is specific: a reviewer clicks "Students", lands on the sign-in
   * page, and concludes the demo is broken. The one exception is the
   * WhatsApp share link, which composes a message rather than navigating.
   */
  readOnly?: boolean;
};

// Where a teacher goes to satisfy each public-listing signal. The two
// *Touched signals are stamped by the same server actions the onboarding
// wizard uses (app/actions/onboarding.ts:193 / :339), which Settings reuses —
// so opening the page and pressing Save genuinely is the fix, even when the
// content already looks correct. The copy says so, because it is otherwise a
// baffling instruction.
const SIGNAL_REMEDY_HREF: Record<MarketplaceSignalKey, string> = {
  onboardingComplete: "/onboarding/reading",
  hasPhoto: "/settings/booking-page",
  hasBio: "/settings/booking-page",
  templatesTouched: "/settings/templates",
  availabilityTouched: "/settings/availability",
  hasPayoutMethod: "/settings/payments",
};

export async function DashboardView(vm: DashboardViewModel) {
  const t = await getT();
  const readOnly = vm.readOnly ?? false;
  // A brand-new teacher has no schedule to lead with, and no reason yet to care
  // about a cash-flow average over zero classes. Sharing her link is the whole
  // job, so it takes the main column and the schedule card renders its
  // first-run empty state underneath it.
  const linkLeads = vm.hasNoActivityYet;

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("home.greeting", { name: vm.teacherName })}
        description={formatZonedDate(vm.now, vm.timezone, vm.locale)}
        actions={
          // Booking on a student's behalf only makes sense once she has
          // students; the first-run guidance below covers the rest.
          vm.hasNoActivityYet ? null : (
            <Button asChild={!readOnly} disabled={readOnly}>
              {readOnly ? (
                <span>{t("teacherBook.cta")}</span>
              ) : (
                <Link href="/dashboard/classes/book">{t("teacherBook.cta")}</Link>
              )}
            </Button>
          )
        }
      />

      {/* Gated on !marketplaceReady, not
          hasNoActivityYet — a teacher who already has students/bookings but
          never connected a payout rail still needs to see this, which the old
          isNewTeacher-only gate silently stopped surfacing the moment her
          first booking landed. Reuses <Alert> instead of hand-rolled Card
          styling (audit finding). It stays full width and above both columns:
          it is the one thing on the page that blocks everything else. */}
      {!vm.marketplaceReady && (
        <Alert variant="warning">
          <AlertTitle as="h2">{t("web.dashboard.home.startHere.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("web.dashboard.home.startHere.description")}</p>
            {/* Name the blockers rather than deferring to the checklist below:
                GrowthSignals has no templatesTouched/availabilityTouched, so a
                teacher blocked on only those two would read "follow the
                checklist" and find every step already ticked. */}
            <p className="mt-2 font-medium">{t("web.dashboard.home.notPublic.whatsMissing")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {vm.missingSignals.map((key) => (
                <li key={key}>
                  <MaybeLink href={SIGNAL_REMEDY_HREF[key]} readOnly={readOnly} underline>
                    {t(`web.dashboard.home.notPublic.${key}`)}
                  </MaybeLink>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* `items-start` so a short aside does not stretch to the main column's
          height and leave its last card floating in whitespace.

          `min-w-0` ON BOTH COLUMNS, and it is load-bearing rather than
          defensive. A grid track's `auto` minimum is floored by its item's
          MIN-CONTENT width, and `truncate` (which is `white-space: nowrap`)
          makes a line's min-content the width of the whole unwrapped string —
          so one long student name or timezone label in the schedule card sized
          this column to 523px and pushed every card on the page off the side
          of a 390px phone. `min-w-0` on the flex item inside the row is not
          enough: it lets that item SHRINK once the track has a width, but it
          does not lower the track's floor. This does, which is what lets the
          truncation actually happen. */}
      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {linkLeads && <BookingLinkCard vm={vm} t={t} readOnly={readOnly} />}
          <UpcomingClasses vm={vm} t={t} readOnly={readOnly} />
          {/* Once every step is done the checklist has nothing left to ask
              for, and a permanently-complete five-item list is just furniture.
              GrowthChecklist keeps rendering it while there is a step to take. */}
          {!vm.growth.complete && (
            <GrowthChecklist checklist={vm.growth} bookingUrl={vm.bookingUrl} locale={vm.locale} />
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          {vm.cashFlow && vm.cashFlow.byCurrency.some((s) => s.totalPaidCents > 0) && (
            <SafeToSpendTile cashFlow={vm.cashFlow} />
          )}
          {!linkLeads && <BookingLinkCard vm={vm} t={t} readOnly={readOnly} />}
          <PaymentsStatus vm={vm} t={t} readOnly={readOnly} />
        </aside>
      </div>

      <ShortcutGrid vm={vm} t={t} readOnly={readOnly} />
    </PageShell>
  );
}

type T = Awaited<ReturnType<typeof getT>>;
type SectionProps = { vm: DashboardViewModel; t: T; readOnly: boolean };

/**
 * The schedule — the page's lead, and the question this screen previously had
 * no answer to.
 *
 * Rendered as one divided list rather than a stack of boxed rows: the next
 * class earns its emphasis from size and space (a larger time, more room
 * around it) rather than from a border, which keeps the whole card reading as
 * a single sequence. Hierarchy from scale and space is the same instrument
 * D-140 leans on everywhere else, and it is the one that still works when a
 * reader has turned the text size up.
 */
function UpcomingClasses({ vm, t, readOnly }: SectionProps) {
  const [next, ...later] = vm.schedule.upcoming;
  const zoneLabel = timezoneCityLabel(vm.timezone);

  return (
    <Card>
      {/* `px-4 sm:px-6` here, on the rows and on the footer alike: on a 390px
          phone the row's 24px gutters were 48px of the 358px card, and the
          rows below need every pixel of it. The three have to move together or
          the title stops lining up with the names under it. */}
      <CardHeader className="gap-2 px-4 pb-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-lg" as="h2">
            {t("web.dashboard.home.schedule.title")}
          </CardTitle>
          {vm.schedule.weekAhead > 0 && (
            <Badge variant="secondary">
              {t("web.dashboard.home.schedule.weekAhead", { count: vm.schedule.weekAhead })}
            </Badge>
          )}
        </div>
        {/* The zone caveat belongs beside the times it qualifies, not orphaned
            under the greeting as a bare IANA id (which is what it used to be). */}
        <CardDescription>
          {t("web.dashboard.home.schedule.timesShownIn", { tz: zoneLabel })}
        </CardDescription>
      </CardHeader>

      {next ? (
        <CardContent className="p-0">
          <ul className="divide-border divide-y border-t">
            <li>
              <ClassRow booking={next} vm={vm} t={t} readOnly={readOnly} featured />
            </li>
            {later.map((booking) => (
              <li key={booking.id}>
                <ClassRow booking={booking} vm={vm} t={t} readOnly={readOnly} />
              </li>
            ))}
          </ul>
          <div className="px-4 py-4 sm:px-6">
            <Button asChild={!readOnly} variant="outline" size="sm" disabled={readOnly}>
              {readOnly ? (
                <span>{t("home.viewAll")}</span>
              ) : (
                <Link href="/dashboard/classes">{t("home.viewAll")}</Link>
              )}
            </Button>
          </div>
        </CardContent>
      ) : (
        <CardContent>
          <div className="flex items-start gap-3">
            <CalendarDays className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">{t("web.dashboard.home.schedule.none")}</p>
              <p className="text-muted-foreground text-sm">
                {vm.hasNoActivityYet
                  ? t("web.dashboard.home.schedule.noneHelpNewTeacher")
                  : t("web.dashboard.home.schedule.noneHelp")}
              </p>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

/**
 * One class in the schedule list.
 *
 * The time column is fixed-width and `tabular-nums` so the times form a true
 * column that the eye can run down — a proportional-figure list of times
 * ragged on both edges is measurably slower to scan, and this is the one place
 * on the page where scanning is the whole task.
 */
function ClassRow({
  booking,
  vm,
  t,
  readOnly,
  featured = false,
}: {
  booking: DashboardUpcomingClass;
  vm: DashboardViewModel;
  t: T;
  readOnly: boolean;
  featured?: boolean;
}) {
  // The teacher is the viewer here — always. The student's zone is the "other"
  // side, and it is only worth the line when the two clocks actually disagree.
  const zoned = getDualZoneTime(
    booking.scheduledStart,
    { tz: vm.timezone, label: t("web.dualZone.yourTime") },
    { tz: booking.studentTimezone ?? vm.timezone, label: booking.studentName },
    vm.locale,
    vm.now,
  );
  const meta = [
    booking.packageName,
    booking.durationMin
      ? t("web.dashboard.home.schedule.durationMin", { count: booking.durationMin })
      : null,
  ].filter(Boolean);

  const inner = (
    <>
      {/* `whitespace-nowrap` rather than a hard width: "12:00 PM" at the
          featured size is already close to the column, and a reader who has
          turned the text scale up would otherwise get a two-line clock. */}
      <div className="w-24 shrink-0 whitespace-nowrap">
        <div className="text-muted-foreground text-sm">{zoned.viewer.dateLabel}</div>
        <div className={`font-semibold tabular-nums ${featured ? "text-h3" : ""}`}>
          {zoned.viewer.timeLabel}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {/* The "Next up" label belongs to the row it describes, not to the card
            — as a standalone line above the list it read as a second heading
            for the whole section. */}
        {featured && (
          <Badge variant="outline" className="mb-1">
            {t("web.dashboard.home.schedule.nextUp")}
          </Badge>
        )}
        <div className={`truncate ${featured ? "font-semibold" : "font-medium"}`}>
          {booking.studentName}
        </div>
        {/* `sm:truncate`, so this WRAPS on a phone. Truncated, "Business
            Spanish · 50 min" became "Business Spanish · 5…" in 160px — the
            ellipsis ate the duration, which is the half of the line she cannot
            get from anywhere else on the row. From `sm` up the width is there
            and one clean line is better. */}
        {meta.length > 0 && (
          <div className="text-muted-foreground text-sm sm:truncate">
            {meta.map((item, i) => (
              <span key={item}>
                {/* The separator is decoration; it is not part of what the row
                    says, so it does not go into the accessible name. */}
                {i > 0 && <span aria-hidden="true"> · </span>}
                {item}
              </span>
            ))}
          </div>
        )}
        {/* Only when the two clocks genuinely differ — an identical second time
            on every row is noise that trains the eye to skip the line that
            matters on the one booking where it does differ.

            `text-subtle`, not `text-foreground-subtle`: the latter is not a
            class Tailwind can build (see ui/heading.tsx), so this line had been
            rendering at full `foreground` weight — the same weight as the
            student's name above it — since it was written.

            `sm:truncate` for the same reason as the meta line above: this line
            is the longest on the row (325px for "Tom Whitfield's time: 9:00 PM
            (Europe/London)"), so on a phone truncation left "Tom Whitfield's
            time: …" — the label with the answer cut off, which is worse than
            no line at all. It wraps instead. */}
        {!zoned.sameWallClock && (
          <div className="text-subtle text-sm sm:truncate">
            {t("web.dualZone.otherPartyTime", {
              name: zoned.other.label,
              time: `${zoned.other.timeLabel} (${zoned.other.tzDisplay})`,
            })}
          </div>
        )}
      </div>
      <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden />
    </>
  );

  const className = `min-h-target flex w-full items-center gap-3 px-4 transition-colors sm:gap-4 sm:px-6 ${
    featured ? "py-4" : "py-3"
  }`;

  if (readOnly) {
    return <div className={className}>{inner}</div>;
  }
  // Deliberately no `aria-label`: one would REPLACE the row's content as the
  // link's accessible name, so a screen-reader user would hear "Open the class
  // with Mariana Duarte" and lose the time, the day and the duration — the
  // three things the row exists to tell them. The content is the better name.
  return (
    <Link href={`/dashboard/classes/${booking.id}`} className={`${className} hover:bg-muted/50`}>
      {inner}
    </Link>
  );
}

/**
 * Her shopfront address.
 *
 * The URL used to render in a full-width monospace slab styled like a code
 * sample — a developer artifact, not the thing she pastes into WhatsApp. It is
 * still monospace, deliberately: this is a string a student may retype, and
 * unambiguous `l`/`1`/`O`/`0` is the same legibility argument D-140 makes for
 * the body face. What changed is that it now reads as a field with actions
 * beside it, and it only claims the main column for a teacher whose job this
 * actually is (see `linkLeads`).
 */
function BookingLinkCard({ vm, t, readOnly }: SectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("home.bookingLink")}
        </CardTitle>
        <CardDescription>
          {vm.marketplaceReady
            ? t("web.dashboard.home.bookingLinkDescription")
            : t("web.dashboard.home.bookingLinkNotPublicYet")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* The link previously always
            rendered as live/shareable regardless of payment-rail status —
            once public listing gates on marketplaceReady, sharing it
            before then would send students to a page that can't take
            payment. This note makes the gap visible instead of silent. */}
        {!vm.marketplaceReady && (
          <p className="text-warning text-sm font-medium">
            {t("web.dashboard.home.bookingLinkNotPublicYetWarning")}
          </p>
        )}
        <div className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-sm break-all">
          {vm.bookingUrl}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyLinkButton value={vm.bookingUrl} />
          <Button asChild variant="secondary" size="sm">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(
                t("web.dashboard.home.whatsappShareText", { url: vm.bookingUrl }),
              )}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("web.dashboard.home.shareOnWhatsapp")}
            </a>
          </Button>
          {/* Inert in demo mode. The booking page IS public, so linking it
              is tempting — but the demo's slug belongs to a teacher who does
              not exist, so the link would 404. A dead link on the showcase
              page is worse than a disabled one. */}
          <Button asChild={!readOnly} variant="ghost" size="sm" disabled={readOnly}>
            {readOnly ? (
              <span>{t("home.preview")}</span>
            ) : (
              <Link href={`/b/${vm.bookingSlug}`} target="_blank">
                {t("home.preview")}
              </Link>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Payments is a one-time setup task, so once a rail is connected it collapses
 * to an unobtrusive status line instead of a full card. It only surfaces as a
 * prominent CTA while nothing is connected.
 *
 * The connected state used to be a literal "✓" glyph concatenated into a
 * translated string. That carries the status in a character a screen reader
 * announces as "check mark" or skips entirely, and it sits outside the Badge
 * variants that were built for exactly this. It is a <Badge variant="success">
 * with the word in it now — D-140's "status is never carried by hue alone",
 * satisfied by the component rather than by a glyph.
 */
function PaymentsStatus({ vm, t, readOnly }: SectionProps) {
  const rails = [
    vm.stripeConnected ? "Stripe" : null,
    vm.transferConnected ? t("web.settings.payments.transferLabel") : null,
  ].filter(Boolean);

  if (rails.length > 0) {
    return (
      <div className="bg-muted/20 space-y-2 rounded-lg border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t("home.paymentsActive")}
          </Badge>
          <span className="text-muted-foreground text-sm">{rails.join(" + ")}</span>
        </div>
        {/* Underline rather than `text-primary`. The primary token measures
            3.48:1 against the raised card in dark mode — it is verified as a
            BUTTON FILL (`primaryText` on `primary` in palette-contrast.test.ts)
            and never as text on a surface, so every `text-primary` link in the
            app is unmeasured and this one failed axe. An underline carries the
            affordance without depending on the hue, which is the same rule
            D-140 already applies to status. */}
        <MaybeLink
          href="/settings/payments"
          readOnly={readOnly}
          underline
          className="text-sm font-medium"
        >
          {t("home.managePayments")}
        </MaybeLink>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("home.payments")}
        </CardTitle>
        <CardDescription>
          {vm.stripeAvailable ? t("home.paymentsSetup") : t("home.paymentsSetupWiseOnly")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild={!readOnly} disabled={readOnly}>
          {readOnly ? (
            <span>{t("home.paymentsSetUpCta")}</span>
          ) : (
            <Link href="/settings/payments">{t("home.paymentsSetUpCta")}</Link>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The customizable "Day to day" shortcuts.
 *
 * Not a card any more. This grid is a third rendering of an IA that already
 * exists in the header bar, the tablet sidebar and the account menu, and as a
 * bordered card at full page width it was both the largest element on the
 * screen and the one carrying the least information. As a plain section at the
 * foot of the page it still does its real job — reaching the long tail, in the
 * order she chose — without competing with her schedule for the first look.
 *
 * Three columns at lg rather than two: fourteen two-line tiles in two columns
 * is seven rows of scrolling for what is fundamentally an index.
 */
function ShortcutGrid({ vm, t, readOnly }: SectionProps) {
  return (
    <section aria-labelledby="dashboard-shortcuts" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Heading level={3} as="h2" id="dashboard-shortcuts">
            {t("home.dayToDay")}
          </Heading>
          <p className="text-muted-foreground text-sm">
            {t("web.dashboard.home.shortcutsSubtitle")}
          </p>
        </div>
        <Button asChild={!readOnly} variant="ghost" size="sm" disabled={readOnly}>
          {readOnly ? (
            <span>{t("home.customize")}</span>
          ) : (
            <Link href="/dashboard/customize">{t("home.customize")}</Link>
          )}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {webNavLinks(vm.visibleTileKeys, vm.locale, { bookingSlug: vm.bookingSlug }).map((item) => (
          <NavTile
            key={item.key}
            item={item}
            badge={item.key === "leads" ? vm.newLeadCount : 0}
            readOnly={readOnly}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A link that goes inert in demo mode. Rendered as a <span> rather than a
 * disabled anchor so it never takes keyboard focus — a reviewer tabbing
 * through the demo should not stop on eleven controls that do nothing.
 */
function MaybeLink({
  href,
  readOnly,
  className,
  underline,
  children,
}: {
  href: string;
  readOnly: boolean;
  className?: string;
  underline?: boolean;
  children: React.ReactNode;
}) {
  if (readOnly) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link
      href={href}
      className={underline ? `underline underline-offset-2 ${className ?? ""}` : className}
    >
      {children}
    </Link>
  );
}

// One dashboard shortcut tile, resolved from the shared IA model. External
// destinations (the public page) open in a new tab; internal ones are soft
// navigations. `badge` shows an optional count (new leads) when > 0.
//
// The icon column is the same one the mobile drawer and tablet sidebar already
// render (lib/nav-icons) — a fourteen-item index of two-line text blocks is
// read word by word; the same list with a leading glyph is read by shape.
function NavTile({
  item,
  badge = 0,
  readOnly = false,
}: {
  item: WebNavLink;
  badge?: number;
  readOnly?: boolean;
}) {
  const Icon = navIcon(item.key);
  const className =
    "bg-card min-h-target flex items-start gap-3 rounded-md border p-3 transition-colors";
  const inner = (
    <>
      {Icon && <Icon className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" aria-hidden />}
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-medium">
          {item.label}
          {badge > 0 && (
            <span className="bg-primary text-primary-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold">
              {badge}
            </span>
          )}
        </div>
        {item.description && (
          <div className="text-muted-foreground text-sm">{item.description}</div>
        )}
      </div>
    </>
  );

  // External destinations are public, so they stay live even in demo mode.
  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:border-primary/40 hover:bg-muted/40`}
      >
        {inner}
      </a>
    );
  }
  if (readOnly) {
    return <div className={`${className} opacity-80`}>{inner}</div>;
  }
  return (
    <Link href={item.href} className={`${className} hover:border-primary/40 hover:bg-muted/40`}>
      {inner}
    </Link>
  );
}
