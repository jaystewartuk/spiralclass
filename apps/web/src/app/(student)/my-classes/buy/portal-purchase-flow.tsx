"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { Lock } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createPortalCheckoutIntent, type CheckoutState } from "@/app/actions/checkout";
import { formatMinorUnits } from "@/lib/money";
import {
  offersTwoPerson,
  priceForSeats,
  type PayoutInstrument,
  type Seats,
} from "@spiralclass/shared";
import { currentSessionId } from "@/lib/analytics/posthog-browser";
import { useFormatMoney, useT } from "@/components/locale-provider";
import type { TFunction } from "@/lib/i18n-translate";
import { HelpTip } from "@/components/help-tip";

type Method = "stripe" | "manual_transfer";

// What the picker actually holds: "stripe", or the id of the instrument the
// student chose. A single string keeps the radio group trivial, and the two
// wire fields are derived from it at submit — the instrument id is what the
// server needs, because "which payee instructions did this student see" is
// not recoverable from the kind alone (D-113).
const STRIPE_SELECTION = "stripe";

// See checkout-form.tsx (public funnel) for the same pattern/rationale.
const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

type Template = {
  id: string;
  name: string;
  classCount: number;
  classDurationMin: number;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
  // The prices for two people (D-188); null when not sold for two.
  twoPersonPriceMinorUnits: number | null;
  twoPersonTransferPriceMinorUnits: number | null;
  expirationMonths: number | null;
};

// Signed-in package picker + pay action. The public PurchaseFlow collects
// the buyer's details on the right-hand side; here the whole form reduces
// to "which package, which rail" because identity comes from the session.
//
// grandfathering: when this student has an agreed price for a package,
// the server charges it regardless of catalog price — so display it too (for
// both rails; there's no separate grandfathered Wise price).
//
// Per package since 2026-09-01. The flat number this replaces was applied to
// EVERY row of this list, so a student grandfathered at an old 4-class price
// saw the 20-class package at that price, labelled "your agreed price", and
// buying it charged it. Keyed by template id now, and a package with no entry
// renders — and charges — the catalog price.
export function PortalPurchaseFlow({
  teacherId,
  templates,
  currency,
  agreedPrices,
  stripeReady,
  instruments,
}: {
  teacherId: string;
  templates: Template[];
  // The teacher's own pricing currency. Every price here used to format with
  // formatMinorUnits' MXN default, so a teacher pricing in GBP showed her
  // returning students "$1,850.00 MXN".
  currency: string;
  /** Agreed price per template id. A missing key means the catalog price. */
  agreedPrices: Record<string, number>;
  stripeReady: boolean;
  // Already filtered to the offerable ones by the page (enabled, detail on
  // file, currency-compatible) — this component renders what it is given.
  instruments: PayoutInstrument[];
}) {
  const t = useT();
  const formatMoney = useFormatMoney();
  const money = (minorUnits: number) => formatMoney(minorUnits, currency);

  // One person or two (D-188) — asked only when something is sold for two.
  const forTwoAvailable = templates.some(offersTwoPerson);
  const [seats, setSeats] = useState<Seats>(1);
  const visibleTemplates = seats === 2 ? templates.filter(offersTwoPerson) : templates;
  const [partnerConsent, setPartnerConsent] = useState(false);

  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const selected = visibleTemplates.find((t) => t.id === selectedId) ?? visibleTemplates[0];

  const transferReady = instruments.length > 0;
  const [selection, setSelection] = useState<string>(
    stripeReady ? STRIPE_SELECTION : (instruments[0]?.id ?? STRIPE_SELECTION),
  );
  const method: Method = selection === STRIPE_SELECTION ? "stripe" : "manual_transfer";

  const [state, formAction, pending] = useActionState<CheckoutState, FormData>(
    createPortalCheckoutIntent,
    undefined,
  );

  // Collapsed by default — see the box below for why.
  const [showDiscount, setShowDiscount] = useState(false);
  const errorMessage = state && "error" in state ? state.error : undefined;
  const clientSecret = state && "clientSecret" in state ? state.clientSecret : undefined;

  // Forward the PostHog session id so payment_received (fired from the
  // Stripe webhook / Wise confirm long after the student left this tab)
  // can link back to the session recording. Refreshed just before submit
  // because posthog-js may not have a session id yet at mount time.
  const sessionIdRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sessionIdRef.current) {
      sessionIdRef.current.value = currentSessionId() ?? "";
    }
  }, []);

  if (!selected) return null;

  const single = visibleTemplates.length === 1;
  // Show the picker whenever there is more than one thing to pick, not just
  // when Stripe and a transfer coexist — two transfer instruments and no
  // Stripe is a real configuration (a teacher with Wise and SPEI).
  const optionCount = (stripeReady ? 1 : 0) + instruments.length;
  const showToggle = optionCount > 1;
  const noMethods = optionCount === 0;

  // An agreed price is a price for one person — it never prices a package for
  // two, the same rule the server charges by (effectivePriceMinorUnits).
  const agreedFor = (tpl: Template): number | undefined =>
    seats === 1 ? agreedPrices[tpl.id] : undefined;
  const catalogPrice = (tpl: Template, m: Method): number => priceForSeats(tpl, seats, m) ?? 0;
  const effectivePrice = (tpl: Template): number => agreedFor(tpl) ?? catalogPrice(tpl, method);

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
      }}
      className="space-y-5"
    >
      <input type="hidden" name="teacherId" value={teacherId} />
      <input type="hidden" name="templateId" value={selected.id} />
      <input type="hidden" name="paymentMethod" value={method} />
      <input
        type="hidden"
        name="instrumentId"
        value={selection === STRIPE_SELECTION ? "" : selection}
      />
      <input ref={sessionIdRef} type="hidden" name="posthogSessionId" defaultValue="" />
      <input type="hidden" name="seats" value={seats} />
      <input type="hidden" name="partnerConsent" value={partnerConsent ? "1" : ""} />

      {forTwoAvailable && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t("web.buyFlow.seats.legend")}</legend>
          <div className="grid grid-cols-2 gap-2">
            {([1, 2] as const).map((s) => (
              <MethodOption
                key={s}
                id={`seats-${s}`}
                name="seats-choice"
                label={s === 1 ? t("web.buyFlow.seats.one") : t("web.buyFlow.seats.two")}
                checked={seats === s}
                onSelect={() => {
                  setSeats(s);
                  const list = s === 2 ? templates.filter(offersTwoPerson) : templates;
                  if (!list.some((tpl) => tpl.id === selectedId)) setSelectedId(list[0]?.id ?? "");
                }}
              />
            ))}
          </div>
          {seats === 2 && (
            <p className="text-xs text-muted-foreground">{t("web.buyFlow.seats.twoHint")}</p>
          )}
        </fieldset>
      )}

      {showToggle && (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
            {t("buy.method.title")}
            <HelpTip
              text={t("web.help.hint.studentPayments.text")}
              label={t("web.help.hint.studentPayments.label")}
              learnMoreHref="/help/student/buying-packages-and-payments"
              learnMoreLabel={t("web.help.learnMore")}
            />
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {stripeReady && (
              <MethodOption
                id="pm-stripe"
                label={t("web.studentBuy.methodCard")}
                checked={selection === STRIPE_SELECTION}
                onSelect={() => setSelection(STRIPE_SELECTION)}
              />
            )}
            {instruments.map((instrument) => (
              <MethodOption
                key={instrument.id}
                id={`pm-${instrument.id}`}
                label={t(`buy.method.${instrument.kind}`)}
                checked={selection === instrument.id}
                onSelect={() => setSelection(instrument.id)}
              />
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          {single ? t("web.studentBuy.yourPackage") : t("buyAnother.choosePackage")}
        </legend>
        {visibleTemplates.map((tpl) => {
          const price = effectivePrice(tpl);
          const agreed = agreedFor(tpl);
          const transferPrice = catalogPrice(tpl, "manual_transfer");
          // The transfer saving is a property of the CATALOG price split, so
          // it is meaningless once an agreed price overrides both rails.
          const savings = agreed === undefined ? catalogPrice(tpl, "stripe") - transferPrice : 0;
          const hasTransferDiscount = transferReady && savings > 0;
          const checked = tpl.id === selected.id;
          return (
            <label
              key={tpl.id}
              className={`flex items-start justify-between gap-3 rounded-lg border p-4 transition-colors ${
                single ? "" : "cursor-pointer"
              } ${checked ? "border-foreground bg-muted/40" : "hover:bg-muted/30"}`}
            >
              <div className="flex items-start gap-3">
                {!single && (
                  <input
                    type="radio"
                    name="package"
                    value={tpl.id}
                    checked={checked}
                    onChange={() => setSelectedId(tpl.id)}
                    className="mt-1 size-4 cursor-pointer accent-foreground"
                  />
                )}
                <div>
                  <div className="font-medium">{tpl.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {seats === 2 && `${t("web.buyFlow.package.forTwo")} · `}
                    {describe(tpl, t)}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold tabular-nums">{money(price)}</div>
                {agreed !== undefined && (
                  <div className="text-xs text-muted-foreground">
                    {t("web.studentBuy.yourAgreedPrice")}
                  </div>
                )}
                {hasTransferDiscount &&
                  (method === "manual_transfer" ? (
                    <div className="text-xs text-success">
                      {t("web.studentBuy.youSave", { amount: money(savings) })}
                    </div>
                  ) : (
                    // Card selected: reveal the cheaper transfer price upfront
                    // so the saving is visible before the student decides.
                    <div className="text-xs text-success">
                      {t("web.studentBuy.wisePriceWithSavings", {
                        wisePrice: money(transferPrice),
                        savings: money(savings),
                      })}
                    </div>
                  ))}
              </div>
            </label>
          );
        })}
      </fieldset>

      {/* A code is enterable HERE, not only on the public funnel. The server
          action has always read `discountCode` from this form; nothing ever
          submitted it, so a signed-in student had no way to spend one. That
          stranded the referrer's own reward in particular: the "your referral
          earned you a reward" email prints the code and links to /my-classes,
          which is this flow. Collapsed behind a link for the same conversion
          reason as the public funnel — an empty discount box reads as "you are
          paying full price" to the majority who have no code. */}
      {showDiscount ? (
        <div className="space-y-1">
          <Label htmlFor="portal-discount">{t("web.checkoutForm.discountCodeOptional")}</Label>
          <Input
            id="portal-discount"
            name="discountCode"
            autoCapitalize="characters"
            autoComplete="off"
            placeholder={t("web.checkoutForm.discountPlaceholder")}
            disabled={noMethods || pending}
          />
        </div>
      ) : (
        <Button
          type="button"
          variant="link"
          onClick={() => setShowDiscount(true)}
          disabled={noMethods || pending}
          className="h-auto justify-start px-0 text-sm text-muted-foreground hover:text-foreground"
        >
          {t("web.checkoutForm.haveDiscountCode")}
        </Button>
      )}

      {seats === 2 && (
        <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
          <Checkbox
            id="portal-partner-consent"
            checked={partnerConsent}
            onCheckedChange={(v) => setPartnerConsent(v === true)}
            disabled={noMethods || pending}
            className="mt-0.5"
            aria-describedby="portal-partner-consent-hint"
          />
          <div className="min-w-0 space-y-1">
            <Label htmlFor="portal-partner-consent" className="text-sm">
              {t("web.checkoutForm.partnerConsentLabel")}
            </Label>
            <p id="portal-partner-consent-hint" className="text-xs text-muted-foreground">
              {t("web.checkoutForm.partnerConsentHint")}
            </p>
          </div>
        </div>
      )}

      {errorMessage && (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={noMethods || pending || (seats === 2 && !partnerConsent)}
      >
        {pending
          ? t("web.studentBuy.redirecting")
          : ctaCopy(method, money(effectivePrice(selected)), t)}
      </Button>
      {method === "stripe" && (
        <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          {t("buy.trust.secure")}
        </p>
      )}
      {/* Legal seller-of-record statement — rail-aware, same
          rationale as the public checkout's CheckoutForm. Lives here (not
          the page footer) because this is the one place in this flow that
          already tracks the selected rail. */}
      <p className="text-center text-xs leading-snug text-muted-foreground">
        {method === "manual_transfer"
          ? t("buyAnother.disclaimer.wise")
          : t("buyAnother.disclaimer.stripe")}
      </p>
    </form>
  );
}

function describe(tpl: Template, t: TFunction): string {
  const base = t("web.studentBuy.classCountDuration", {
    classCount: tpl.classCount,
    classDurationMin: tpl.classDurationMin,
  });
  if (!tpl.expirationMonths) return base;
  const key =
    tpl.expirationMonths === 1 ? "web.studentBuy.validMonth" : "web.studentBuy.validMonths";
  return t(key, { base, count: tpl.expirationMonths });
}

function ctaCopy(method: Method, price: string, t: TFunction): string {
  if (method === "manual_transfer") return t("common.continue");
  return t("web.studentBuy.payAmount", { price });
}

function MethodOption({
  id,
  name = "method-toggle",
  label,
  checked,
  onSelect,
}: {
  id: string;
  name?: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition-colors ${
        checked ? "border-foreground bg-muted/40" : "hover:bg-muted/30"
      }`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="size-4 cursor-pointer accent-foreground"
      />
      <span className="font-medium">{label}</span>
    </label>
  );
}
