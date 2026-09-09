"use client";

import { Heading } from "@/components/ui/heading";
import Image from "next/image";
import { useState } from "react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckoutForm, type CheckoutPrefill } from "./checkout-form";
import { ClassSlotPicker } from "./class-slot-picker";
import type { SlotInputsWire } from "@/lib/booking/slot-inputs";
import { formatPriceForBuyer } from "@spiralclass/shared";
import { priceForMethod } from "@/lib/payments/instruments";
import { type PayoutInstrument } from "@spiralclass/shared";
import { useT, useLocale } from "@/components/locale-provider";
import { HelpTip } from "@/components/help-tip";
import { Quote, ShieldCheck } from "lucide-react";

type Method = "stripe" | "manual_transfer";

// The picker's value: "stripe", or the id of the chosen payout instrument.
// The id (not just the kind) is what the server needs — see D-113.
const STRIPE_SELECTION = "stripe";

type Template = {
  id: string;
  name: string;
  classCount: number;
  singleClass: boolean;
  classDurationMin: number;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
  expirationMonths: number | null;
  currency: string;
  // Approximate US cents for this package's headline price, or null when the
  // page isn't sold in English, the teacher already prices in USD, or the
  // stored FX rate is too old to quote. Computed on the server (the rate lives
  // in the database) so this component stays presentational.
  approxUsdCents: number | null;
};

// Teacher booking settings needed to generate slots for a single class.
export type SlotTeacherConfig = {
  timezone: string;
  bufferMin: number;
  minAdvanceH: number;
  maxAdvanceDays: number;
};

// One published quote, carried over from the landing page so the checkout is
// not the only screen in the funnel with no social proof on it.
export type CheckoutTestimonial = {
  body: string;
  authorName: string;
  authorNote: string | null;
};

function describe(tpl: Template, t: ReturnType<typeof useT>): string {
  if (tpl.singleClass) {
    return t("web.buyFlow.package.singleClass", { min: tpl.classDurationMin });
  }
  const base = t("web.buyFlow.package.multiClass", {
    count: tpl.classCount,
    min: tpl.classDurationMin,
  });
  if (!tpl.expirationMonths) return base;
  const unit =
    tpl.expirationMonths === 1 ? t("web.buyFlow.package.month") : t("web.buyFlow.package.months");
  return `${base} · ${t("web.buyFlow.package.validFor", { count: tpl.expirationMonths, unit })}`;
}

// Single-column checkout, ordered by the buyer's decision sequence rather than
// by the data model.
//
//   1. Who and what — her face, her name, the package already chosen, the price.
//   2. Pay — name, email, the button.
//   3. Why it's safe — one quote, the cancellation promise, the Stripe lock.
//   4. Other ways to pay — a disclosure, not a first question.
//   5. First class time — after the money for a package, BEFORE it for a single
//      class, where it is a hard requirement rather than an offer.
//
// It was a two-column grid with the payment-rail switcher as the first control
// on the page and the package list re-asked underneath it. Three things were
// wrong with that and all three were measured or observable:
//
//   * The rail switcher led. A stranger who has just decided to spend MX$1,300
//     was asked to reason about Stripe vs SPEI before seeing what they were
//     confirming — and the default was Card, which this teacher could not
//     actually accept until 2026-08-30.
//   * The package list was asked twice. The landing page's rows are links
//     carrying `?package=`, so the choice arrives already made; `package_selected`
//     fires only on a real change and had never fired once in the product's
//     history. It is now a summary line with a Change affordance.
//   * On a phone the grid stacked the `<h1>` BELOW the content it titles, and
//     put the pay button under everything. Single column fixes the order by
//     construction, and with the package collapsed and the rails demoted the
//     button now lands near the first fold rather than needing a sticky bar.
export function PurchaseFlow({
  slug,
  teacherName,
  teacherPhotoUrl,
  testimonial,
  templates,
  initialTemplateId,
  stripeReady,
  instruments,
  prefill,
  prefillCode,
  slotTeacher,
  slotInputs,
}: {
  slug: string;
  teacherName: string;
  teacherPhotoUrl: string | null;
  testimonial: CheckoutTestimonial | null;
  templates: Template[];
  initialTemplateId?: string;
  stripeReady: boolean;
  // Already filtered to the offerable ones by the page (D-113). One option is
  // rendered per instrument, so a teacher with Wise and SPEI shows both.
  instruments: PayoutInstrument[];
  prefill?: CheckoutPrefill;
  prefillCode?: string;
  // Present whenever the teacher has any live offering, so the slot picker can
  // render without another server round-trip.
  slotTeacher?: SlotTeacherConfig;
  slotInputs?: SlotInputsWire;
}) {
  const t = useT();
  const locale = useLocale();

  const posthog = usePostHog();

  // Honor a ?package=<id> deep link from the profile page when it matches a
  // live template; otherwise fall back to the cheapest (first) package.
  const initialId = templates.find((t) => t.id === initialTemplateId)?.id ?? templates[0]?.id ?? "";
  const [selectedId, setSelectedId] = useState(initialId);
  const selected = templates.find((t) => t.id === selectedId) ?? templates[0];

  // Chosen class time (UTC ISO) — the reservation for a single class, the
  // first class for a package. Cleared whenever the student switches to a
  // different offering, since slot grids are per-duration.
  const [intendedStart, setIntendedStart] = useState<string | null>(null);
  // The picker holds "stripe" or an instrument id — see STRIPE_SELECTION.
  // Prefer Stripe when available, for parity with the pre-transfer behaviour.
  const [selection, setSelection] = useState<string>(
    stripeReady ? STRIPE_SELECTION : (instruments[0]?.id ?? STRIPE_SELECTION),
  );
  const method: Method = selection === STRIPE_SELECTION ? "stripe" : "manual_transfer";
  const selectedInstrument = instruments.find((i) => i.id === selection) ?? null;

  const single = templates.length === 1;
  // Whether the package list is expanded. Collapsed by default — the choice
  // arrived with the visitor — and there is nothing to expand for a teacher
  // selling exactly one thing.
  const [showPackages, setShowPackages] = useState(false);

  const selectTemplate = (id: string) => {
    setSelectedId(id);
    setIntendedStart(null);
    setShowPackages(false);

    // Which package a visitor actually picks, and whether she picked it at
    // all. Fired only from this handler — never for the page's own initial
    // selection (?package= or the cheapest) — because counting the default as
    // a choice would make the cheapest package look far more popular than it
    // is. Client-side for the same reason as checkout_submitted below it in
    // the funnel: selecting a package hits no server, so there is nothing to
    // hang a server event on.
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      posthog?.capture("package_selected", {
        slug,
        templateId: tpl.id,
        templateName: tpl.name,
        classCount: tpl.classCount,
        singleClass: tpl.singleClass,
        // The price for the rail currently selected — what she is actually
        // being quoted, not the headline Stripe price.
        priceMinorUnits: priceForMethod(tpl, method),
        currency: tpl.currency,
        // The instrument kind, matching checkout_started/payment_received's
        // vocabulary so the three events compare without a translation step.
        method: selectedInstrument?.kind ?? "stripe",
      });
    }
  };

  if (!selected) return null;

  // More than one thing to pick — which includes two transfer instruments and
  // no Stripe (a MX teacher offering both Wise and SPEI).
  const optionCount = (stripeReady ? 1 : 0) + instruments.length;
  const showToggle = optionCount > 1;
  const noMethods = optionCount === 0;
  // The rail question is only worth demoting when there is a working default to
  // demote it BEHIND. With no card rail the transfer instruments are the only
  // way to pay at all, so they stay in the open where they can't be missed.
  const demoteMethods = showToggle && stripeReady;

  const money = (minorUnits: number) => formatPriceForBuyer(minorUnits, selected.currency, locale);
  const selectedPrice = priceForMethod(selected, method);
  const transferSaving = instruments.length
    ? priceForMethod(selected, "stripe") - priceForMethod(selected, "manual_transfer")
    : 0;

  const methodOptions = (
    <div className="grid gap-2 sm:grid-cols-2">
      {stripeReady && (
        <MethodOption
          id="m-stripe"
          label={t("web.buyFlow.method.stripeShort")}
          checked={selection === STRIPE_SELECTION}
          onSelect={() => setSelection(STRIPE_SELECTION)}
        />
      )}
      {instruments.map((instrument) => (
        <MethodOption
          key={instrument.id}
          id={`m-${instrument.id}`}
          // Named so the student recognizes the payee BEFORE sending — this
          // rail's main defence against "student says sent, teacher can't find
          // it". D-145 left one kind, so one label; the account formats that
          // used to be named by their own brand here ("SPEI", "PIX", "IBAN")
          // went with it, and Stripe offers SPEI itself now.
          label={t("web.buyFlow.method.wiseShort")}
          checked={selection === instrument.id}
          onSelect={() => setSelection(instrument.id)}
        />
      ))}
    </div>
  );

  const slotPicker =
    slotTeacher && slotInputs ? (
      <ClassSlotPicker
        timezone={slotTeacher.timezone}
        bufferMin={slotTeacher.bufferMin}
        minAdvanceH={slotTeacher.minAdvanceH}
        maxAdvanceDays={slotTeacher.maxAdvanceDays}
        classDurationMin={selected.classDurationMin}
        inputs={slotInputs}
        value={intendedStart}
        onChange={setIntendedStart}
        optional={!selected.singleClass}
      />
    ) : null;

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      {/* 1 — Who you're buying from, and what you chose. */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-3">
            {teacherPhotoUrl && (
              <Image
                src={teacherPhotoUrl}
                alt={teacherName}
                width={96}
                height={96}
                className="size-12 shrink-0 rounded-full border object-cover"
              />
            )}
            <Heading level={2} as="h1" className="text-xl lg:text-2xl">
              {t("book.packagesWith", { name: teacherName })}
            </Heading>
          </div>

          {showPackages || single ? (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                {single ? t("web.buyFlow.yourPackage") : t("buy.choosePackage")}
              </legend>
              {templates.map((tpl) => {
                const checked = tpl.id === selected.id;
                const price = priceForMethod(tpl, method);
                return (
                  <label
                    key={tpl.id}
                    className={`flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors ${
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
                          onChange={() => selectTemplate(tpl.id)}
                          className="mt-1 size-4 cursor-pointer accent-foreground"
                        />
                      )}
                      <div>
                        <div className="font-medium">{tpl.name}</div>
                        <div className="text-xs text-muted-foreground">{describe(tpl, t)}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold tabular-nums">
                        {formatPriceForBuyer(price, tpl.currency, locale)}
                      </div>
                      {tpl.approxUsdCents !== null && (
                        <div className="text-xs tabular-nums text-muted-foreground">
                          {t("web.buyFlow.approxPrice", {
                            price: formatPriceForBuyer(tpl.approxUsdCents, "USD", locale),
                          })}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </fieldset>
          ) : (
            <div className="flex items-start justify-between gap-3 border-t pt-4">
              <div className="min-w-0">
                <div className="font-medium">{selected.name}</div>
                <div className="text-xs text-muted-foreground">{describe(selected, t)}</div>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => setShowPackages(true)}
                  className="h-auto p-0 text-xs underline"
                >
                  {t("web.buyFlow.changePackage")}
                </Button>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-lg font-semibold tabular-nums">{money(selectedPrice)}</div>
                {selected.approxUsdCents !== null && (
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {t("web.buyFlow.approxPrice", {
                      price: formatPriceForBuyer(selected.approxUsdCents, "USD", locale),
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* A single class cannot be paid for without a time, so its picker has to
          come BEFORE the pay button — otherwise the button sits disabled above
          the only control that can enable it. A package's first class is an
          offer, so it waits until after (below). */}
      {selected.singleClass && slotPicker}

      {/* 2 — Pay. */}
      <Card>
        <CardContent className="pt-6">
          {/* Remount on package change so error state + fields reset cleanly
              for the chosen package. Method changes don't remount, so typed
              details survive a method switch. */}
          <CheckoutForm
            key={selected.id}
            slug={slug}
            templateId={selected.id}
            priceMinorUnits={selected.priceMinorUnits}
            transferPriceMinorUnits={selected.transferPriceMinorUnits}
            currency={selected.currency}
            method={method}
            instrumentId={selectedInstrument?.id ?? null}
            instrumentKind={selectedInstrument?.kind ?? null}
            noMethods={noMethods}
            prefill={prefill}
            prefillCode={prefillCode}
            requireSlot={selected.singleClass}
            intendedStartUtc={intendedStart}
          />
        </CardContent>
      </Card>

      {/* 3 — The reassurance that was previously only on the landing page. The
          moment of maximum doubt was the one screen carrying none of it. */}
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("web.bookingLanding.included.reschedule.body")}
        </p>
        {testimonial && (
          <figure className="space-y-2 rounded-lg border bg-muted/30 p-4">
            <Quote className="h-4 w-4 text-primary/60" aria-hidden />
            <blockquote className="whitespace-pre-line text-xs leading-relaxed text-foreground/80">
              {testimonial.body}
            </blockquote>
            <figcaption className="text-xs text-muted-foreground">
              {testimonial.authorName}
              {testimonial.authorNote ? ` · ${testimonial.authorNote}` : ""}
            </figcaption>
          </figure>
        )}
      </div>

      {/* 4 — Other rails. A question, not a gate. */}
      {showToggle &&
        (demoteMethods ? (
          <details className="rounded-lg border px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
            <summary className="cursor-pointer list-none text-sm">
              <span className="underline underline-offset-2">
                {t("web.buyFlow.otherWaysToPay")}
              </span>
              {transferSaving > 0 && (
                <span className="ml-2 text-success">
                  {t("web.buyFlow.youSave", { amount: money(transferSaving) })}
                </span>
              )}
            </summary>
            <div className="mt-3 space-y-2">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {t("buy.method.title")}
                <HelpTip
                  text={t("web.help.hint.studentPayments.text")}
                  label={t("web.help.hint.studentPayments.label")}
                  learnMoreHref="/help"
                  learnMoreLabel={t("web.help.learnMore")}
                />
              </p>
              {methodOptions}
            </div>
          </details>
        ) : (
          <fieldset className="space-y-2 rounded-lg border p-4">
            <legend className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
              {t("buy.method.title")}
              <HelpTip
                text={t("web.help.hint.studentPayments.text")}
                label={t("web.help.hint.studentPayments.label")}
                learnMoreHref="/help"
                learnMoreLabel={t("web.help.learnMore")}
              />
            </legend>
            {methodOptions}
          </fieldset>
        ))}

      {/* 5 — A package's first class: offered, never required. */}
      {!selected.singleClass && slotPicker}
    </div>
  );
}

function MethodOption({
  id,
  label,
  checked,
  onSelect,
}: {
  id: string;
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
        name="method-toggle"
        checked={checked}
        onChange={onSelect}
        className="size-4 cursor-pointer accent-foreground"
      />
      <span className="font-medium">{label}</span>
    </label>
  );
}
