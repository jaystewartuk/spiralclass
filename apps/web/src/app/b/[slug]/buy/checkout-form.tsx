"use client";

import { useActionState, useEffect, useRef, useState } from "react";
// formatPriceForBuyer is the buyer-facing formatter used by the package rows
// on the landing page and by the summary above this form. It was
// `formatMinorUnits` here, which renders "$1,300.00 MXN" where the rest of the
// funnel renders "MX$1,300.00" — two spellings of the one number the buyer is
// checking hardest.
import {
  formatPriceForBuyer,
  suggestEmailCorrection,
  type PayoutInstrumentKind,
  railForKind,
} from "@spiralclass/shared";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCheckoutIntent, type CheckoutState } from "@/app/actions/checkout";
import { priceForMethod } from "@/lib/payments/instruments";
import { Lock } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { currentSessionId } from "@/lib/analytics/posthog-browser";
import { useT, useLocale } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";
import { readIntroVideoWatch } from "@/lib/analytics/intro-video-watch";

type Method = "stripe" | "manual_transfer";

// Loaded once per page (module scope, not per-render) — Stripe's own
// documented pattern. Resolves to null (never mounts EmbeddedCheckout) when
// the publishable key isn't configured for this deploy, matching the
// server's Stripe-optional degrade-gracefully behavior.
const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

// Seeded from the signed-in student's linked row (when a session exists) so
// a repeat buyer doesn't retype — and, more importantly, doesn't re-typo —
// the email that keys their identity. Fields stay editable: someone buying
// for another person on a signed-in device can still overwrite them.
export type CheckoutPrefill = {
  name: string;
  email: string;
};

// The buyer's details + the pay action. The payment method is chosen by
// PurchaseFlow (now a disclosure below this form, not a first question) and
// handed down as `method` so the summary price and this form's CTA stay in
// sync. We never pass the price up to the
// server — it re-reads from the DB; the figure shown here is display-only.
export function CheckoutForm({
  slug,
  templateId,
  priceMinorUnits,
  transferPriceMinorUnits,
  currency,
  method,
  instrumentId,
  instrumentKind,
  noMethods,
  prefill,
  prefillCode,
  // For a single-class purchase the student must pick a slot first; its UTC
  // start rides along so the auto-book-on-paid job can turn it into a booking.
  // `requireSlot` gates the pay button until a time is chosen.
  intendedStartUtc = null,
  requireSlot = false,
}: {
  slug: string;
  templateId: string;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
  currency: string;
  method: Method;
  // The chosen instrument, for `manual_transfer`. Null for Stripe. Forwarded
  // as a hidden field so the server knows WHICH payee instructions this
  // student was shown (D-113); `instrumentKind` is the analytics label, kept
  // in the same vocabulary as checkout_started/payment_received.
  instrumentId: string | null;
  instrumentKind: PayoutInstrumentKind | null;
  noMethods: boolean;
  prefill?: CheckoutPrefill;
  prefillCode?: string;
  intendedStartUtc?: string | null;
  requireSlot?: boolean;
}) {
  const [state, formAction, pending] = useActionState<CheckoutState, FormData>(
    createCheckoutIntent,
    undefined,
  );
  const posthog = usePostHog();
  // Resolves through the <LocaleProvider> pinned by app/b/layout.tsx, so this
  // form now speaks the same language as the page around it. It previously
  // hardcoded English while the landing page followed Accept-Language — the
  // one component in the funnel that couldn't drift, next to the ones that did.
  const t = useT();
  const locale = useLocale();
  const errorMessage = state && "error" in state ? state.error : undefined;
  // React 19 resets an uncontrolled form once its action resolves, restoring
  // each field to its current `defaultValue`. Feeding the submitted values
  // back in as the defaults is what makes that reset land on what the buyer
  // typed rather than on empty — see CheckoutFormValues in actions/checkout.ts.
  const submitted = state && "values" in state ? state.values : undefined;
  const clientSecret = state && "clientSecret" in state ? state.clientSecret : undefined;

  // Forward the PostHog session id so payment_received (fired from the
  // Stripe webhook / Wise confirm long after the student left this tab)
  // can link back to the session recording. The ref is refreshed just
  // before submit because posthog-js may not have a session id yet at
  // mount time (depends on autocapture readiness + sampling).
  const sessionIdRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sessionIdRef.current) {
      sessionIdRef.current.value = currentSessionId() ?? "";
    }
  }, []);

  // Typo guard: the email typed here BECOMES the student's identity (and
  // where their sign-in links go), so a one-keystroke domain slip quietly
  // creates a second roster profile. Non-blocking hint, computed on blur
  // from the visitor's own input only.
  const emailRef = useRef<HTMLInputElement>(null);
  const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);
  const acceptSuggestion = () => {
    if (emailRef.current && emailSuggestion) {
      emailRef.current.value = emailSuggestion;
    }
    setEmailSuggestion(null);
  };

  // A visible, empty discount box depresses conversion — buyers without a
  // code feel they're paying a non-discounted price and leave to hunt for
  // one. So the field stays collapsed behind a link and only opens for the
  // few who have a code. A code arriving via a shareable link (prefillCode)
  // opens it automatically so the buyer sees it's already applied.
  const [showDiscount, setShowDiscount] = useState(Boolean(prefillCode));

  const displayPrice = priceForMethod({ priceMinorUnits, transferPriceMinorUnits }, method);

  // A Stripe checkout renders the Payment Element inline, in place of the
  // form, once the server hands back a client_secret — Stripe's own UI then
  // owns card entry + the pay button + the redirect to buy/result on success.
  if (clientSecret && stripePromise) {
    return (
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={() => {
        if (sessionIdRef.current) {
          sessionIdRef.current.value = currentSessionId() ?? "";
        }
        // Client-side funnel marker: the student actually submitted the form
        // (JS ran, validation passed). Pairs with the server-side
        // checkout_started — a gap between the two distinguishes form/JS
        // abandons (left before submit, or JS never ran) from server-side
        // drop-offs. No PII in the payload; the email/name live only in the
        // server event's resolved student id.
        // Stamped with the visitor's intro-video watch state (D-73) so the
        // "does watching the intro convert better?" question is ONE insight
        // with a breakdown, rather than a hand-computed ratio between two
        // separate funnels that don't share a denominator. `watched: false` is
        // the control group, not missing data.
        const introVideo = readIntroVideoWatch(slug);
        posthog?.capture("checkout_submitted", {
          slug,
          templateId,
          method: instrumentKind ? railForKind(instrumentKind) : "stripe",
          watched_intro_video: introVideo.watched,
          intro_video_max_percent: introVideo.maxPercent,
        });
      }}
      className="space-y-3"
    >
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="templateId" value={templateId} />
      <input type="hidden" name="paymentMethod" value={method} />
      <input type="hidden" name="instrumentId" value={instrumentId ?? ""} />
      <input type="hidden" name="intendedStartUtc" value={intendedStartUtc ?? ""} />
      <input ref={sessionIdRef} type="hidden" name="posthogSessionId" defaultValue="" />

      <div className="space-y-1">
        <Label htmlFor={`name-${templateId}`}>
          {t("web.checkoutForm.yourName")}{" "}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </Label>
        <Input
          id={`name-${templateId}`}
          name="studentName"
          autoComplete="name"
          required
          aria-required="true"
          defaultValue={submitted?.studentName ?? prefill?.name ?? ""}
          disabled={noMethods || pending}
          invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? `checkout-error-${templateId}` : undefined}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`email-${templateId}`}>
          {t("web.checkoutForm.yourEmail")}{" "}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </Label>
        <Input
          ref={emailRef}
          id={`email-${templateId}`}
          name="studentEmail"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          aria-required="true"
          defaultValue={submitted?.studentEmail ?? prefill?.email ?? ""}
          disabled={noMethods || pending}
          invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? `checkout-error-${templateId}` : undefined}
          onBlur={(e) => setEmailSuggestion(suggestEmailCorrection(e.target.value))}
          onChange={() => emailSuggestion && setEmailSuggestion(null)}
        />
        {emailSuggestion && (
          <button
            type="button"
            onClick={acceptSuggestion}
            className="text-warning text-left text-xs underline underline-offset-2"
          >
            {t("web.checkoutForm.didYouMean")}{" "}
            <span className="font-medium">{emailSuggestion}</span>?
          </button>
        )}
      </div>
      {showDiscount ? (
        <div className="space-y-1">
          <Label htmlFor={`discount-${templateId}`}>
            {t("web.checkoutForm.discountCodeOptional")}
          </Label>
          <Input
            id={`discount-${templateId}`}
            name="discountCode"
            autoCapitalize="characters"
            autoComplete="off"
            placeholder={t("web.checkoutForm.discountPlaceholder")}
            defaultValue={prefillCode ?? ""}
            disabled={noMethods || pending}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowDiscount(true)}
          disabled={noMethods || pending}
          className="text-muted-foreground hover:text-foreground text-left text-sm underline underline-offset-2 disabled:opacity-50"
        >
          {t("web.checkoutForm.haveDiscountCode")}
        </button>
      )}
      {errorMessage && (
        <p
          id={`checkout-error-${templateId}`}
          role="alert"
          aria-live="polite"
          className="text-destructive text-sm"
        >
          {errorMessage}
        </p>
      )}
      {requireSlot && !intendedStartUtc && (
        <p className="text-muted-foreground text-sm">{t("web.checkoutForm.pickTimeFirst")}</p>
      )}
      <Button
        type="submit"
        className="w-full"
        disabled={noMethods || pending || (requireSlot && !intendedStartUtc)}
      >
        {pending
          ? t("web.checkoutForm.redirecting")
          : ctaCopy(t, method, formatPriceForBuyer(displayPrice, currency, locale))}
      </Button>
      {method === "stripe" && (
        <p className="text-muted-foreground flex items-center justify-center gap-1 text-xs">
          <Lock className="h-3.5 w-3.5" />
          {t("web.checkoutForm.securePaymentStripe")}
        </p>
      )}
      {/* Legal/tax (CFDI) seller-of-record statement — rail-aware because the
          Stripe copy ("SpiralClass processes the charge") is factually wrong
          for Wise, where the transfer goes direct to the teacher. Both
          variants keep the seller-of-record sentence. Lives here (not the
          page footer) because this is the one place in the funnel that
          already tracks the selected rail. */}
      <p className="text-muted-foreground text-center text-xs leading-snug">
        {method === "manual_transfer"
          ? t("buy.sellerDisclaimer.wise")
          : t("buy.sellerDisclaimer.stripe")}
      </p>
    </form>
  );
}

function ctaCopy(t: TFunction, method: Method, price: string): string {
  if (method === "manual_transfer") return t("common.continue");
  return t("web.checkoutForm.payAmount", { price });
}
