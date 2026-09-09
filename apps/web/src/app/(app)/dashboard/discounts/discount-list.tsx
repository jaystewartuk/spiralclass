import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { CopyLinkButton } from "@/components/copy-link-button";
import { formatMinorUnits } from "@/lib/money";
import type { AppLocale } from "@/lib/i18n";
import type { StringKey, TFunction } from "@/lib/i18n-translate";
import { discountUrgency, type CodeTotals, type DiscountState } from "@/lib/discounts/status";
import { cn } from "@/lib/utils";
import { DiscountCodeActions } from "./discount-forms";

/**
 * The codes, as one sequence rather than a stack of cards.
 *
 * WHAT THIS REPLACES. Every code was its own `<Card>` in a `space-y-3` column,
 * carrying a mono code, a value chip, and one grey line of run-together
 * fragments: "Used 3/10 · max 1 per student · expires 2026-09-30". Three
 * separate defects lived in that line.
 *
 *   - IT COULD NOT SAY A CODE WAS DEAD. The only state it rendered was the
 *     `active` column, so a code that had expired, or had spent its last
 *     redemption, looked exactly like a working one. The teacher shared it and
 *     the student was told at checkout that it had expired — by the one screen
 *     that had every fact needed to tell her first. See lib/discounts/status.ts.
 *   - THE DATE WAS AN ISO SLICE. `2026-09-30` in every language, including the
 *     two that do not write dates that way.
 *   - IT NEVER SAID WHAT A CODE HAD COST. `DiscountRedemption.amountMinorUnits`
 *     has recorded the exact discount given since the table existed, and
 *     nothing read it. "3 uses" is a number; "3 uses, £45 off, on £320 of
 *     sales" is a decision.
 */

export type DiscountRow = {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  percentBps: number | null;
  amountMinorUnits: number | null;
  currency: string;
  active: boolean;
  maxRedemptions: number | null;
  perStudentLimit: number;
  expiresAt: Date | null;
  createdAt: Date;
  state: DiscountState;
  totals: CodeTotals;
};

export type ListContext = {
  t: TFunction;
  locale: AppLocale;
  now: Date;
  /** Absolute origin, so the copied link works when pasted anywhere. */
  checkoutBase: string;
};

/** What the code takes off: "15%" or "£20". */
function valueLabel(row: DiscountRow): string {
  return row.kind === "percent"
    ? `${(row.percentBps ?? 0) / 100}%`
    : formatMinorUnits(row.amountMinorUnits ?? 0, row.currency);
}

/**
 * The expiry, on the UTC calendar it was stored against.
 *
 * `timeZone: "UTC"` and not the teacher's zone: the date came from an unzoned
 * `<input type="date">` and was pinned to the end of that UTC day, so rendering
 * it in a local zone is what would move it — a teacher in Mexico City picking
 * the 30th would be shown the 29th.
 */
function expiryLabel(expiresAt: Date, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(expiresAt);
}

type StateBadge = { variant: "success" | "outline" | "secondary"; key: StringKey };

/**
 * How each state looks.
 *
 * `paused` is an outline rather than a fill because it is HERS — she turned it
 * off and can turn it back on. `expired` and `usedUp` are the neutral
 * `secondary`: facts about the world, not something to act on.
 */
const STATE_BADGE: Record<DiscountState, StateBadge> = {
  live: { variant: "success", key: "web.dashboard.discounts.state.live" },
  paused: { variant: "outline", key: "web.dashboard.discounts.state.paused" },
  expired: { variant: "secondary", key: "web.dashboard.discounts.state.expired" },
  usedUp: { variant: "secondary", key: "web.dashboard.discounts.state.usedUp" },
};

/**
 * How far through its cap a code is.
 *
 * Only drawn when there IS a cap — a bar with no end is a bar that cannot fill,
 * and it would read as "barely used" on the most successful uncapped code she
 * owns. Decorative: the row already says "3 of 10 used" in words directly
 * above it, so a second announcement is noise.
 */
function UsageBar({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  // Built as a string first: an inline literal in the style object would be a
  // token bypass, and a percentage cannot be a utility class.
  const width = `${pct}%`;
  return (
    <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full rounded-full bg-primary" style={{ width }} />
    </div>
  );
}

function DiscountRowView({ row, ctx }: { row: DiscountRow; ctx: ListContext }) {
  const { t, locale, now, checkoutBase } = ctx;
  const live = row.state === "live";
  const badge = STATE_BADGE[row.state];
  // The four fields the state machine reads. `usedCount` lives on `totals`
  // rather than on the row, so it is assembled here rather than stored twice.
  const facts = {
    active: row.active,
    expiresAt: row.expiresAt,
    maxRedemptions: row.maxRedemptions,
    usedCount: row.totals.used,
  };
  const urgency = discountUrgency(facts, now, row.state);

  // The usage sentence, in one of three shapes rather than a "3/10" fraction
  // the reader has to decode.
  const usage =
    row.maxRedemptions != null
      ? t("web.dashboard.discounts.usedOfMax", {
          used: row.totals.used,
          max: row.maxRedemptions,
        })
      : row.totals.used > 0
        ? t("web.dashboard.discounts.usedCount", { count: row.totals.used })
        : t("web.dashboard.discounts.notUsedYet");

  const meta = [
    usage,
    t("web.dashboard.discounts.perStudentCount", { count: row.perStudentLimit }),
    row.expiresAt
      ? t(
          // Past tense follows the DATE, not the row's state — a paused code
          // with a future expiry has not ended, it is waiting.
          row.expiresAt <= now
            ? "web.dashboard.discounts.endedOn"
            : "web.dashboard.discounts.endsOn",
          { date: expiryLabel(row.expiresAt, locale) },
        )
      : null,
  ].filter((part): part is string => Boolean(part));

  // What it has actually cost, and what it sold. Absent until there is
  // something to say, rather than a row of zeroes on every unused code.
  const money =
    row.totals.used > 0
      ? row.totals.salesMinorUnits > 0
        ? t("web.dashboard.discounts.gaveAwayOnSales", {
            amount: formatMinorUnits(row.totals.givenMinorUnits, row.currency),
            sales: formatMinorUnits(row.totals.salesMinorUnits, row.currency),
          })
        : t("web.dashboard.discounts.gaveAway", {
            amount: formatMinorUnits(row.totals.givenMinorUnits, row.currency),
          })
      : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:gap-4 lg:px-6">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* The code is the row's identity, so it gets the weight and the
              mono face — it is a string that has to be transcribed exactly. */}
          <span
            className={cn("font-mono text-base font-semibold", !live && "text-muted-foreground")}
          >
            {row.code}
          </span>
          <span className="text-sm font-medium">
            {t("web.dashboard.discounts.valueOff", { value: valueLabel(row) })}
          </span>
          <Badge variant={badge.variant}>{t(badge.key)}</Badge>
          {/* One warning at most, and only while it can still be acted on. */}
          {urgency?.kind === "runningOut" && (
            <Badge variant="warning">
              {t("web.dashboard.discounts.usesLeft", { count: urgency.left })}
            </Badge>
          )}
          {urgency?.kind === "expiring" && (
            <Badge variant="warning">
              {urgency.days === 0
                ? t("web.dashboard.discounts.endsToday")
                : t("web.dashboard.discounts.endsInDays", { count: urgency.days })}
            </Badge>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {meta.map((part, i) => (
            <span key={part}>
              {/* Decoration, not something to announce. */}
              {i > 0 && <span aria-hidden> · </span>}
              {part}
            </span>
          ))}
        </p>

        {money && <p className="text-sm font-medium tabular-nums">{money}</p>}

        {row.maxRedemptions != null && <UsageBar used={row.totals.used} max={row.maxRedemptions} />}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {/* Sharing is offered only for a code that would actually work. A copy
            button on an expired code hands her a link that fails at checkout. */}
        {live && (
          <CopyLinkButton
            value={`${checkoutBase}?ref=${encodeURIComponent(row.code)}`}
            label={t("web.dashboard.discounts.copyLink")}
            ariaLabel={t("web.dashboard.discounts.copyLinkFor", { code: row.code })}
            toastMessage={t("web.dashboard.discounts.linkCopied")}
          />
        )}
        <DiscountCodeActions
          id={row.id}
          code={row.code}
          active={row.active}
          used={row.totals.used > 0}
          // Flipping `active` cannot revive an expired or spent code, so the
          // row does not offer a control that would appear to.
          toggleable={row.state === "live" || row.state === "paused"}
        />
      </div>
    </li>
  );
}

/**
 * One titled group of codes.
 *
 * A real heading and a real `<ul>`: the heading is what a screen-reader user
 * navigates the page by, and the list tells them how many codes the group
 * holds — the same two facts a sighted reader gets from seeing the group.
 */
export function DiscountGroup({
  title,
  rows,
  ctx,
  muted = false,
}: {
  title: string;
  rows: DiscountRow[];
  ctx: ListContext;
  /** The not-redeemable half sits back so the live one reads first. */
  muted?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3">
      <Heading level={4} as="h2" className="text-muted-foreground">
        {title}
      </Heading>
      <Card className={cn(muted && "bg-muted/40 shadow-none")}>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <DiscountRowView key={row.id} row={row} ctx={ctx} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
