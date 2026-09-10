import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import type { StringKey, TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import type { PayoutReadiness, RailState } from "./payout-readiness";

/**
 * The verdict this page exists to deliver, above everything that acts on it.
 *
 * Three rules it follows, each of them a defect in what it replaced:
 *
 *  - **State is a WORD, never a colour.** Every rail's state renders as a
 *    labelled `Badge`; the tone reinforces it and carries none of it alone
 *    (D-140). The old page painted "pending" in `text-warning` inside a run of
 *    plain text, which is both invisible to a screen reader as a state and
 *    unreadable to anyone who cannot separate the hues.
 *  - **Say the consequence.** No rail does not merely mean "not set up" — it
 *    means her public booking page is unlisted (D-104's `hasPayoutMethod`
 *    signal) and no student can reach a checkout at all. That is the single
 *    most important sentence on the screen and the page never said it.
 *  - **One call to action.** When she cannot be paid, the panel ends with the
 *    one button that fixes it, anchored at the section that does. Not two
 *    equally-weighted cards to choose between.
 *
 * It is a `<dl>`: each rail is a label and its state, which is exactly a
 * description list, and the pairing is what a screen reader reads together.
 */
export function PayoutStatusPanel({ readiness, t }: { readiness: PayoutReadiness; t: TFunction }) {
  const { canBePaid, card, wise } = readiness;
  // The one thing she should do next, if anything. Preferring the card rail
  // when both are actionable matches the ordering of the sections below and
  // the fact that it is the rail her students will reach for first.
  const cta = !canBePaid ? (isActionable(card) ? "stripe" : "wise") : null;

  return (
    <Card
      // `aria-labelledby` rather than a role: the headline is already a
      // heading, so the region is named by the words on screen.
      aria-labelledby="payout-status-heading"
      className={cn(
        "space-y-5 p-5 sm:p-6",
        // The border carries the tone; the ground stays the card's own so the
        // panel reads as part of the page rather than as an alert that can be
        // dismissed.
        canBePaid ? "border-success/40" : "border-warning/40",
      )}
      role="region"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            canBePaid ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
          )}
        >
          {canBePaid ? <CircleCheck className="size-5" /> : <CircleAlert className="size-5" />}
        </span>
        <div className="min-w-0 space-y-1">
          <Heading level={3} as="h2" id="payout-status-heading">
            {t(
              canBePaid
                ? "web.settings.payments.status.readyHeadline"
                : "web.settings.payments.status.blockedHeadline",
            )}
          </Heading>
          <p className="text-muted-foreground text-sm">
            {t(
              canBePaid
                ? "web.settings.payments.status.readyBody"
                : "web.settings.payments.status.blockedBody",
            )}
          </p>
        </div>
      </div>

      {/* One row per rail she is actually offered, in the order the sections
          below appear. A rail this deploy has no credentials for is absent
          rather than reported as unavailable — see RailState's `hidden`. */}
      <dl className="divide-border divide-y border-t">
        {card === "hidden" ? null : (
          <RailRow
            name={t("web.settings.payments.method.card")}
            hint={t("web.settings.payments.status.cardHint")}
            state={card}
            t={t}
          />
        )}
        <RailRow
          name={t("web.settings.payments.method.wise")}
          hint={t("web.settings.payments.status.wiseHint")}
          state={wise}
          t={t}
        />
      </dl>

      {cta ? (
        <Button asChild>
          {/* An in-page anchor, not a button with an onClick: it works before
              hydration and gets keyboard and context-menu behaviour from the
              platform, the same reason SectionNav is anchors. */}
          <Link href={`#${cta}`}>{t("web.settings.payments.status.setUpCta")}</Link>
        </Button>
      ) : null}
    </Card>
  );
}

/** A rail she has something to do about. `unavailable` is not one of them. */
function isActionable(state: RailState): boolean {
  return state === "not-connected" || state === "verifying" || state === "incomplete";
}

function RailRow({
  name,
  hint,
  state,
  t,
}: {
  name: string;
  hint: string;
  state: RailState;
  t: TFunction;
}) {
  const { key, variant } = STATE_PRESENTATION[state];
  return (
    // Stacked on a phone, label and state on one line from `sm` up. The old
    // layout was a run of inline spans, which wrapped mid-pair.
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
      <dt className="min-w-0">
        <span className="block text-sm font-medium">{name}</span>
        <span className="text-muted-foreground block text-sm">{hint}</span>
      </dt>
      <dd className="shrink-0">
        <Badge variant={variant}>{t(key)}</Badge>
      </dd>
    </div>
  );
}

/**
 * One state, one word, one tone — declared as a table so a new rail state
 * cannot ship without deciding how it reads. `secondary` for the two states
 * that are neither a problem nor an achievement (`off` is her own choice;
 * `unavailable` is nothing she can act on), so the warning tone stays scarce
 * enough to mean something.
 */
const STATE_PRESENTATION: Record<
  RailState,
  { key: StringKey; variant: "success" | "warning" | "secondary" }
> = {
  live: { key: "web.settings.payments.state.live", variant: "success" },
  verifying: { key: "web.settings.payments.state.verifying", variant: "warning" },
  "not-connected": { key: "web.settings.payments.state.notConnected", variant: "secondary" },
  incomplete: { key: "web.settings.payments.state.needsWisetag", variant: "warning" },
  off: { key: "web.settings.payments.state.off", variant: "secondary" },
  unavailable: { key: "web.settings.payments.state.unavailableHere", variant: "secondary" },
  // Never rendered — a hidden rail has no row. Present so the table stays
  // exhaustive over RailState and a new state cannot be added without one.
  hidden: { key: "web.settings.payments.state.off", variant: "secondary" },
};
