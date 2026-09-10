"use client";

import { useActionState, useEffect, useId, useState } from "react";
import {
  formatMinorUnits,
  previewRewardMinorUnits,
  type ReferralRewardDraft,
} from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError } from "@/components/ui/field-error";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import { usePricingCurrency } from "@/components/pricing-currency-context";
import { saveReferralProgram, type ReferralProgramState } from "@/app/actions/referrals";
import { cn } from "@/lib/utils";

// The teacher's whole referral configuration, as one form.
//
// It is a Client Component for one reason worth stating: the breakdown at the
// bottom recomputes as she types. A referral program is two abstract numbers
// whose consequence is a third number she never sees, and "so what does that
// actually cost me?" is the only question this screen has to answer. Answering
// it on keystroke, in her own currency and against her own package, is the
// difference between a settings form and a decision aid.

export type ProgramInitial = {
  enabled: boolean;
  referred: ReferralRewardDraft;
  referrer: ReferralRewardDraft;
  rewardExpiryDays: number | null;
  /**
   * The package the breakdown prices against; null when she has no priced
   * template yet. It carries its OWN currency: a template priced before she
   * switched currencies is still denominated in the old code, and relabelling
   * it would misstate her own catalogue.
   */
  samplePackage: { name: string; priceMinorUnits: number; currency: string } | null;
};

/**
 * Both units are kept, not one. Percent and a cash amount are not
 * interchangeable quantities, so carrying "15" from the percent field into the
 * currency field would offer a 15-peso reward to someone who meant 15% — and
 * clearing on every switch would lose a saved value to a mis-tap. Each unit
 * keeps its own text, and switching back restores it.
 *
 * Text rather than numbers because a half-typed "1" is not the number 1.
 */
type RewardState = { kind: "percent" | "fixed"; percent: string; amount: string };

function toDraft(state: RewardState): ReferralRewardDraft {
  const raw = state.kind === "percent" ? state.percent : state.amount;
  const parsed = raw.trim() === "" ? null : Number(raw);
  return {
    kind: state.kind,
    percent: state.kind === "percent" ? parsed : null,
    amount: state.kind === "fixed" ? parsed : null,
  };
}

function initialState(reward: ReferralRewardDraft): RewardState {
  return {
    kind: reward.kind,
    percent: reward.percent == null ? "" : String(reward.percent),
    amount: reward.amount == null ? "" : String(reward.amount),
  };
}

/**
 * One reward side: pick a unit, then type a value.
 *
 * The unit picker is a real radio group rather than the two `<Button>`s it
 * replaces. Those carried no group semantics, no selected state for a screen
 * reader and no arrow-key navigation — a control that looked like a choice and
 * announced as two unrelated buttons. Native radios give all three for free.
 */
function RewardFields({
  id,
  side,
  label,
  hint,
  valueLabel,
  state,
  onChange,
  error,
}: {
  /** Owned by the parent so it can move focus here after a failed save. */
  id: string;
  side: "referred" | "referrer";
  label: string;
  hint: string;
  valueLabel: string;
  state: RewardState;
  onChange: (next: RewardState) => void;
  error?: string;
}) {
  const t = useT();
  const currency = usePricingCurrency();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const isPercent = state.kind === "percent";

  const options = [
    { kind: "percent" as const, label: "%" },
    { kind: "fixed" as const, label: currency },
  ];

  return (
    <div className="bg-muted/40 flex flex-col gap-3 rounded-md border p-4">
      <div className="space-y-1">
        <p className="font-semibold">{label}</p>
        <p id={hintId} className="text-muted-foreground text-sm">
          {hint}
        </p>
      </div>

      {/* Only the SELECTED unit's input is rendered, so the other name is
          absent from the FormData rather than present-and-empty — which is the
          shape @/lib/form-data's absent() exists to normalise. */}
      <input type="hidden" name={`${side}Kind`} value={state.kind} />

      {/* Value first, unit second, so the pair reads as one quantity — "15 %" —
          in the order it is spoken. The unit is stated once: an adornment
          inside the field as well would repeat what the selected segment
          immediately beside it already says. */}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="sr-only">
          {valueLabel}
        </Label>
        <Input
          id={id}
          name={isPercent ? `${side}Percent` : `${side}AmountPesos`}
          type="number"
          inputMode="numeric"
          autoComplete="off"
          min={1}
          max={isPercent ? 100 : undefined}
          step={1}
          placeholder={isPercent ? "10" : "100"}
          value={isPercent ? state.percent : state.amount}
          onChange={(event) =>
            onChange({ ...state, [isPercent ? "percent" : "amount"]: event.target.value })
          }
          invalid={error != null}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          className="w-28 text-right tabular-nums"
        />
        <div
          role="radiogroup"
          aria-label={t("web.dashboard.referrals.rewardType")}
          className="border-input bg-background inline-flex h-11 items-center gap-1 rounded-md border p-1 lg:h-10"
        >
          {options.map((option) => (
            <label
              key={option.kind}
              className={cn(
                "relative flex h-full min-w-11 cursor-pointer items-center justify-center rounded-sm px-3 text-sm font-medium transition-colors",
                state.kind === option.kind
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <input
                type="radio"
                name={`${side}Unit`}
                value={option.kind}
                checked={state.kind === option.kind}
                onChange={() => onChange({ ...state, kind: option.kind })}
                className="focus-visible:ring-ring absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-sm focus-visible:ring-3 focus-visible:outline-none"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      <FieldError id={errorId} message={error} />
    </div>
  );
}

/** One line of the cost breakdown; `strong` marks the total. */
function PreviewRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-1.5",
        strong && "border-border mt-1 border-t pt-3 font-semibold",
      )}
    >
      {/* No wrapping on the row: a label that wraps still keeps its amount
          beside it, where a wrapped ROW drops the amount to the next line and
          left-aligns it under the label it belongs to. */}
      <dt className={cn("min-w-0 text-sm", !strong && "text-muted-foreground")}>{label}</dt>
      <dd className="shrink-0 whitespace-nowrap tabular-nums">{value}</dd>
    </div>
  );
}

export function ReferralProgramForm({ initial }: { initial: ProgramInitial }) {
  const t = useT();
  const currency = usePricingCurrency();
  const enabledId = useId();
  const referredId = useId();
  const referrerId = useId();
  const expiryId = useId();
  const expiryHintId = `${expiryId}-hint`;
  const expiryErrorId = `${expiryId}-error`;

  const [referred, setReferred] = useState(() => initialState(initial.referred));
  const [referrer, setReferrer] = useState(() => initialState(initial.referrer));
  const [expiryDays, setExpiryDays] = useState(
    initial.rewardExpiryDays == null ? "" : String(initial.rewardExpiryDays),
  );
  const [state, formAction, pending] = useActionState<ReferralProgramState, FormData>(
    saveReferralProgram,
    undefined,
  );

  // Send the caret to the first field that was actually rejected. A rejected
  // save leaves the reader at the button, several screens below three fields
  // that changed: the message is announced, but nothing takes them to the one
  // they have to fix.
  //
  // Which field is resolved during render rather than inside the effect, so
  // the effect's dependencies are two plain values. `state` is in there
  // alongside because useActionState replaces it per completed action — the
  // id alone would not re-fire when the same field is rejected twice running.
  const firstErrorId = state?.fields?.referred
    ? referredId
    : state?.fields?.referrer
      ? referrerId
      : state?.fields?.expiry
        ? expiryId
        : null;
  useEffect(() => {
    if (firstErrorId) document.getElementById(firstErrorId)?.focus();
  }, [firstErrorId, state]);

  const sample = initial.samplePackage;
  const base = sample?.priceMinorUnits ?? 0;
  const previewCurrency = sample?.currency ?? currency;
  const friendOff = previewRewardMinorUnits(toDraft(referred), base, previewCurrency);
  const studentOff = previewRewardMinorUnits(toDraft(referrer), base, previewCurrency);
  const expiryNumber = Number(expiryDays);
  const expiryValid = expiryDays.trim() !== "" && Number.isFinite(expiryNumber) && expiryNumber > 0;

  return (
    <form action={formAction} className="space-y-5">
      <div className="hover:bg-muted/40 flex items-start gap-3 rounded-md border p-4 transition-colors">
        <Checkbox
          id={enabledId}
          name="enabled"
          value="true"
          defaultChecked={initial.enabled}
          className="mt-1"
        />
        <div className="space-y-1">
          <Label htmlFor={enabledId} className="block text-base font-semibold">
            {t("web.dashboard.referrals.turnOn")}
          </Label>
          <p className="text-muted-foreground text-sm">{t("web.dashboard.referrals.turnOnHint")}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RewardFields
          id={referredId}
          side="referred"
          label={t("web.dashboard.referrals.friendDiscount")}
          hint={t("web.dashboard.referrals.friendDiscountHint")}
          valueLabel={t("web.dashboard.referrals.friendDiscountValue")}
          state={referred}
          onChange={setReferred}
          error={state?.fields?.referred}
        />
        <RewardFields
          id={referrerId}
          side="referrer"
          label={t("web.dashboard.referrals.referrerReward")}
          hint={t("web.dashboard.referrals.referrerRewardHint")}
          valueLabel={t("web.dashboard.referrals.referrerRewardValue")}
          state={referrer}
          onChange={setReferrer}
          error={state?.fields?.referrer}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={expiryId}>{t("web.dashboard.referrals.rewardExpiresAfter")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={expiryId}
            name="rewardExpiryDays"
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min={1}
            max={3650}
            step={1}
            placeholder="90"
            value={expiryDays}
            onChange={(event) => setExpiryDays(event.target.value)}
            invalid={state?.fields?.expiry != null}
            aria-describedby={
              state?.fields?.expiry ? `${expiryHintId} ${expiryErrorId}` : expiryHintId
            }
            className="w-24 text-right"
          />
          <span className="text-muted-foreground text-sm">
            {t("web.dashboard.referrals.rewardExpiryUnit")}
          </span>
        </div>
        <p id={expiryHintId} className="text-muted-foreground text-sm">
          {t("web.dashboard.referrals.rewardExpiryHint")}
        </p>
        <FieldError id={expiryErrorId} message={state?.fields?.expiry} />
      </div>

      {/* "What does this cost me", in her own money. Rendered from the same
          clamped arithmetic checkout will use, so the number she decides on is
          the number her student is charged. */}
      <Card className="shadow-none">
        <CardContent className="space-y-2 p-4">
          <p className="font-semibold">{t("web.dashboard.referrals.preview.title")}</p>
          {sample == null ? (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.referrals.preview.noPackage")}
            </p>
          ) : friendOff == null || studentOff == null ? (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.referrals.preview.incomplete")}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">
                {t("web.dashboard.referrals.preview.onPackage", {
                  package: sample.name,
                  price: formatMinorUnits(base, previewCurrency),
                })}
              </p>
              <dl>
                <PreviewRow
                  label={t("web.dashboard.referrals.preview.friendPays")}
                  value={formatMinorUnits(base - friendOff, previewCurrency)}
                />
                <PreviewRow
                  label={t("web.dashboard.referrals.preview.friendDiscount")}
                  value={formatMinorUnits(friendOff, previewCurrency)}
                />
                <PreviewRow
                  label={t("web.dashboard.referrals.preview.referrerReward")}
                  value={formatMinorUnits(studentOff, previewCurrency)}
                />
                <PreviewRow
                  strong
                  label={t("web.dashboard.referrals.preview.total")}
                  value={formatMinorUnits(friendOff + studentOff, previewCurrency)}
                />
              </dl>
              <p className="text-muted-foreground text-sm">
                {expiryValid
                  ? t("web.dashboard.referrals.preview.expiry", { days: expiryNumber })
                  : t("web.dashboard.referrals.preview.noExpiry")}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t("web.dashboard.referrals.saving") : t("common.save")}
        </Button>
        <FormStatus state={state} savedMessage={t("web.dashboard.referrals.savedNotice")} />
      </div>
    </form>
  );
}
