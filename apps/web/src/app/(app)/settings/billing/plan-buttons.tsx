"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Heading } from "@/components/ui/heading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { startSubscriptionCheckout, type BillingActionState } from "@/app/actions/billing";
import type { PlanOption } from "./plan-options";

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

// There is deliberately no "current plan" state here. The grid only renders for
// a teacher on Free or in trial, and both carry `plan: "free"` — so a card
// marked as her current plan could never appear. It was written, and removed
// once that was checked: a badge and a disabled button that cannot render read
// as a feature to the next person and are really just weight.

// The plan chooser. Each option is its own `<form>` posting to the same server
// action, which is what lets `useFormStatus` give each card its OWN pending
// state — the previous version shared one `pending` across all three, so
// choosing Annual put "Redirecting…" on the Monthly and Founding buttons too.
//
// ONE card leads. Three identically-weighted cards with three identical
// primary buttons hand the reader a comparison the page already knows the
// answer to — so the cheapest-per-month plan (`recommendedPlan`, derived from
// the price table rather than asserted) gets the ring, the badge and the only
// filled button, and the rest step down to `outline`. Emphasis is never the
// ring alone: it is a bordered ring PLUS a worded badge PLUS button weight,
// so it survives a monochrome render and reaches a screen reader.
export function PlanButtons({ options }: { options: PlanOption[] }) {
  const t = useT();
  const [state, action] = useActionState<BillingActionState, FormData>(
    startSubscriptionCheckout,
    undefined,
  );
  // The Checkout Session she backed out of. Keyed by the secret rather than a
  // boolean so choosing a plan again — which mints a NEW session — shows the
  // Payment Element again, instead of staying stuck on the grid or silently
  // re-opening the session she just abandoned.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const errorMessage = state && "error" in state ? state.error : undefined;
  const secret = state && "clientSecret" in state ? state.clientSecret : undefined;
  const clientSecret = secret && secret !== dismissed ? secret : undefined;

  if (clientSecret && stripePromise) {
    return (
      <div className="space-y-3">
        {/* The way back. Committing to a plan used to be a one-way door: the
            Payment Element replaced the grid with no route back to it short of
            reloading the page. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-3"
          onClick={() => setDismissed(clientSecret)}
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t("web.settings.billing.backToPlans")}
        </Button>
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    );
  }

  // When nothing is recommended — a price table where annual no longer
  // undercuts monthly — every card falls back to equal weight rather than to
  // an arbitrary one wearing the ring.
  const hasRecommended = options.some((opt) => opt.recommended);

  return (
    <div className="space-y-4">
      {errorMessage && (
        <Alert variant="destructive" role="alert" aria-live="polite">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      <ul
        className={`grid gap-3 ${options.length > 2 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        {options.map((opt) => (
          <li key={opt.plan}>
            {/* The <li> is the grid cell and the form fills it, rather than the
                <li> carrying `display: contents` — which drops the list item
                from the accessibility tree in several browsers. */}
            <form
              action={action}
              className={cn(
                "flex h-full flex-col rounded-lg border bg-card p-4",
                opt.recommended
                  ? "border-primary shadow-brand-sm ring-1 ring-primary/30"
                  : "border-border",
              )}
            >
              <input type="hidden" name="plan" value={opt.plan} />
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <Heading level={4} as="h3">
                  {opt.title}
                </Heading>
                {opt.recommended && (
                  <Badge variant="default">{t("web.settings.billing.recommended")}</Badge>
                )}
              </div>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-h3 font-semibold tabular-nums">{opt.priceLabel}</span>
                <span className="text-sm text-muted-foreground">{opt.intervalLabel}</span>
              </p>
              {/* Directly under the price, because it IS the price — the one
                  figure that makes an annual charge comparable to a monthly
                  one without the reader doing the division. */}
              {opt.equivalentLabel && (
                <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
                  {opt.equivalentLabel}
                </p>
              )}
              <p className="mt-1 text-sm text-muted-foreground">{opt.subtitle}</p>
              {opt.highlight && (
                <p className="mt-2">
                  <Badge variant={opt.highlightTone ?? "info"}>{opt.highlight}</Badge>
                </p>
              )}
              {opt.footnote && (
                <p className="mt-1.5 text-sm text-muted-foreground">{opt.footnote}</p>
              )}
              {/* `mt-auto` on the wrapper pins every button to the bottom of
                  its card, so the founding card's two extra lines do not push
                  its neighbours' buttons out of alignment. */}
              <div className="mt-auto pt-4">
                <ChoosePlanButton
                  label={t("web.settings.billing.choose")}
                  pendingLabel={t("web.settings.billing.redirecting")}
                  ariaLabel={t("web.settings.billing.chooseAria", { plan: opt.title })}
                  variant={!hasRecommended || opt.recommended ? "default" : "outline"}
                />
              </div>
            </form>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t("web.settings.billing.stripeNote")}</p>
    </div>
  );
}

// Its own component so `useFormStatus` reads the enclosing card's form rather
// than the whole grid — the hook only sees the nearest ancestor <form>, which
// it cannot do from the parent that renders them all.
function ChoosePlanButton({
  label,
  pendingLabel,
  ariaLabel,
  variant,
}: {
  label: string;
  pendingLabel: string;
  ariaLabel: string;
  variant: "default" | "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      // Three buttons reading "Choose" are one item to a screen reader's
      // element list; the label names the plan each one buys.
      aria-label={ariaLabel}
      disabled={pending}
      className="w-full"
    >
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {pending ? pendingLabel : label}
    </Button>
  );
}
