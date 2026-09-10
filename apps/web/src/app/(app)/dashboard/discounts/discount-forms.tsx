"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import { usePricingCurrency } from "@/components/pricing-currency-context";
import { cn } from "@/lib/utils";
import {
  createDiscountCode,
  setDiscountCodeActive,
  deleteDiscountCode,
  type DiscountActionState,
  type DiscountField,
} from "@/app/actions/discounts";

/** Today in UTC, the calendar the expiry is stored against (see expiryInstant). */
function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The percent / fixed-amount switch, as two real radios.
 *
 * It was two `<Button variant={selected ? "default" : "outline"}>`s and a
 * `useState`, which is a segmented control to a sighted mouse user and nothing
 * at all to anyone else: no group, no selected state in the accessibility tree,
 * no arrow keys, and a control whose entire accessible name was "%". Native
 * radios in a fieldset get all four for free, and the visible label is the
 * accessible name rather than a second string that can drift from it.
 */
function TypeChoice({
  value,
  onChange,
  currency,
}: {
  value: "percent" | "fixed";
  onChange: (next: "percent" | "fixed") => void;
  currency: string;
}) {
  const t = useT();
  const options = [
    { key: "percent" as const, label: t("web.dashboard.discounts.typePercent") },
    { key: "fixed" as const, label: t("web.dashboard.discounts.typeFixed", { currency }) },
  ];

  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{t("web.dashboard.discounts.type")}</legend>
      <div className="flex gap-1 rounded-md border border-input bg-muted p-1">
        {options.map((option) => (
          // The label IS the control surface: the radio inside it is visually
          // hidden but still focusable, so the focus ring, the checked state and
          // the arrow-key roving all come from the browser.
          <label
            key={option.key}
            className={cn(
              "flex min-h-target flex-1 cursor-pointer items-center justify-center rounded px-3 text-sm font-medium transition-colors",
              "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background",
              // Both states carry a border so the box does not resize when the
              // selection moves; only the selected one draws it.
              value === option.key
                ? "border border-border bg-card text-foreground shadow-brand-sm"
                : "border border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name="kind"
              value={option.key}
              checked={value === option.key}
              onChange={() => onChange(option.key)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateDiscountForm() {
  const t = useT();
  const currency = usePricingCurrency();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  // Controlled so what she sees is what gets stored: codes are normalized to
  // upper case on the way into the database, and typing "summer25" then finding
  // "SUMMER25" in the list reads as the product changing her mind for her.
  const [code, setCode] = useState("");
  const [state, formAction, pending] = useActionState<DiscountActionState, FormData>(
    createDiscountCode,
    undefined,
  );

  // The form had no success state at all — a created code just appeared in a
  // list she may not have been looking at. Confirm it, name it, and clear the
  // fields so the next one starts from empty rather than from the last one.
  useEffect(() => {
    if (!state?.ok) return;
    toast.success(t("web.dashboard.discounts.created", { code: state.code ?? "" }));
    formRef.current?.reset();
    setCode("");
    setKind("percent");
    codeRef.current?.focus();
  }, [state, t]);

  const errorId = `${uid}-error`;
  const invalid = (field: DiscountField) => state?.field === field;
  // Only the field the server named describes itself with the message; a
  // second aria-describedby pointing at the same text would have a screen
  // reader read the error twice on one form.
  const describedBy = (field: DiscountField, ...extra: string[]) =>
    [...extra, invalid(field) ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor={`${uid}-code`}>{t("web.dashboard.discounts.code")}</Label>
        <Input
          id={`${uid}-code`}
          ref={codeRef}
          name="code"
          required
          maxLength={40}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          placeholder={t("web.dashboard.discounts.codePlaceholder")}
          aria-invalid={invalid("code") || undefined}
          aria-describedby={describedBy("code", `${uid}-code-help`)}
        />
        <p id={`${uid}-code-help`} className="text-xs text-muted-foreground">
          {t("web.dashboard.discounts.codeHelp")}
        </p>
      </div>

      <TypeChoice value={kind} onChange={setKind} currency={currency} />

      {kind === "percent" ? (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-percent`}>{t("web.dashboard.discounts.percentOff")}</Label>
          <Input
            id={`${uid}-percent`}
            name="percent"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            placeholder="15"
            aria-invalid={invalid("value") || undefined}
            aria-describedby={describedBy("value")}
          />
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-amount`}>
            {t("web.dashboard.discounts.amountOffMxn", { currency })}
          </Label>
          <Input
            id={`${uid}-amount`}
            name="amountPesos"
            type="number"
            inputMode="decimal"
            min={1}
            step="1"
            placeholder="200"
            aria-invalid={invalid("value") || undefined}
            aria-describedby={describedBy("value")}
          />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${uid}-per`}>{t("web.dashboard.discounts.perStudent")}</Label>
          <Input
            id={`${uid}-per`}
            name="perStudentLimit"
            type="number"
            inputMode="numeric"
            min={1}
            defaultValue={1}
            aria-invalid={invalid("perStudentLimit") || undefined}
            aria-describedby={describedBy("perStudentLimit", `${uid}-per-help`)}
          />
          <p id={`${uid}-per-help`} className="text-xs text-muted-foreground">
            {t("web.dashboard.discounts.perStudentHelp")}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-max`}>
            {t("web.dashboard.discounts.totalUses")}{" "}
            <span className="font-normal text-muted-foreground">({t("common.optional")})</span>
          </Label>
          <Input
            id={`${uid}-max`}
            name="maxRedemptions"
            type="number"
            inputMode="numeric"
            min={1}
            // Was the glyph "∞", which a screen reader reads as "infinity" and
            // a teacher reads as a placeholder she is supposed to type.
            placeholder={t("web.dashboard.discounts.unlimited")}
            aria-invalid={invalid("maxRedemptions") || undefined}
            aria-describedby={describedBy("maxRedemptions")}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${uid}-exp`}>
          {t("web.dashboard.discounts.expiresOptional")}{" "}
          <span className="font-normal text-muted-foreground">({t("common.optional")})</span>
        </Label>
        <Input
          id={`${uid}-exp`}
          name="expiresAt"
          type="date"
          // The server rejects a past date too — this only means she never gets
          // that far by accident.
          min={todayUtcYmd()}
          aria-invalid={invalid("expiresAt") || undefined}
          aria-describedby={describedBy("expiresAt", `${uid}-exp-help`)}
        />
        <p id={`${uid}-exp-help`} className="text-xs text-muted-foreground">
          {t("web.dashboard.discounts.expiresHelp")}
        </p>
      </div>

      {state?.error && <FieldError id={errorId} message={state.error} />}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t("web.dashboard.discounts.creating") : t("web.dashboard.discounts.createCode")}
      </Button>
    </form>
  );
}

/**
 * The per-row actions.
 *
 * `code` is here for the accessible names: every row renders a button reading
 * "Pause", so on a list of six codes a screen-reader user heard "Pause, button"
 * six times with nothing to tell them apart. The visible label stays the short
 * one and the accessible name carries the code, which is what "accessible name
 * contains the visible label" is for.
 */
export function DiscountCodeActions({
  id,
  code,
  active,
  used,
  /** Expired and fully-used codes: `active` no longer decides anything. */
  toggleable,
}: {
  id: string;
  code: string;
  active: boolean;
  used: boolean;
  toggleable: boolean;
}) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeState, activeAction, activePending] = useActionState<DiscountActionState, FormData>(
    setDiscountCodeActive,
    undefined,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<DiscountActionState, FormData>(
    deleteDiscountCode,
    undefined,
  );

  // A failed toggle or delete used to discard its message entirely — the row's
  // state simply did not change and nothing said why.
  useEffect(() => {
    const message = activeState?.error ?? deleteState?.error;
    if (message) toast.error(message);
  }, [activeState, deleteState]);

  // Closed by the ANSWER, not by the click: dismissing the dialog inside the
  // submit handler unmounts the form React is mid-dispatch on, and leaves a
  // "has-redemptions" refusal with nowhere to have come from.
  useEffect(() => {
    if (deleteState) setConfirmOpen(false);
  }, [deleteState]);

  return (
    <div className="flex items-center gap-1">
      {toggleable && (
        <form action={activeAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="active" value={active ? "false" : "true"} />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={activePending}
            aria-label={t(
              active ? "web.dashboard.discounts.pauseCode" : "web.dashboard.discounts.resumeCode",
              { code },
            )}
          >
            {active ? t("web.dashboard.discounts.pause") : t("web.dashboard.discounts.resume")}
          </Button>
        </form>
      )}
      {/* Delete is offered only for never-used codes; used ones are paused. */}
      {!used && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          trigger={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={deletePending}
              aria-label={t("web.dashboard.discounts.deleteCode", { code })}
            >
              {t("common.delete")}
            </Button>
          }
          title={t("web.dashboard.discounts.deleteTitle", { code })}
          description={t("web.dashboard.discounts.deleteBody")}
          footer={(close) => (
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t("common.cancel")}
              </Button>
              <form action={deleteAction}>
                <input type="hidden" name="id" value={id} />
                <Button type="submit" variant="destructive" disabled={deletePending}>
                  {t("common.delete")}
                </Button>
              </form>
            </>
          )}
        />
      )}
    </div>
  );
}
