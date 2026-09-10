"use client";

import { useActionState, useId, useState } from "react";
import { ExternalLink } from "lucide-react";
import { isValidWiseHandle } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/components/locale-provider";
import { WISE_PAY_BASE_URL } from "@/lib/wise";
import { updateWiseInstrument, type PayoutInstrumentState } from "@/app/actions/payout-instruments";

export type WiseFormProps = {
  enabled: boolean;
  handle: string | null;
  accountHolder: string | null;
  email: string | null;
};

/**
 * The Wise payout instrument (D-113).
 *
 * One form, one submit: we don't split "enable" from "details", so the teacher
 * fills the handle in the same step as flipping the toggle — the validator
 * (and the CHECK constraint behind it) refuse to enable an instrument with
 * nothing to pay to. The three fields are ordered by consequence: the switch
 * that decides whether students see Wise at all, then the one value a payment
 * actually goes to, then two optional reassurances.
 *
 * WHAT CHANGED, and why it is not cosmetic. The Wisetag hint used to be
 * assembled from two catalog strings around a hardcoded `wise.com/pay/` — a
 * URL shape that **404s**, and has since 2026-05. The link her student really
 * opens is `wise.com/pay/me/<handle>`, built by `buildWisePayUrl`, so the one
 * field on this page that must be exactly right was illustrated with a form of
 * the link that does not resolve. It now renders `WISE_PAY_BASE_URL` — the
 * same constant the builder uses, so the two cannot drift again — live, as she
 * types, and as a real openable link once the handle is one Wise would accept.
 */
export function WiseForm(props: WiseFormProps) {
  const t = useT();
  const [state, formAction, pending] = useActionState<PayoutInstrumentState, FormData>(
    updateWiseInstrument,
    undefined,
  );
  // Local, purely so the preview below the field can track what she is typing.
  // The field stays uncontrolled in every way that matters to the server: the
  // action reads FormData, not this.
  const [handle, setHandle] = useState(props.handle ?? "");
  const trimmed = handle.trim();
  const handleValid = isValidWiseHandle(trimmed);
  const errorId = useId();
  const previewId = useId();

  return (
    <form action={formAction} className="space-y-6">
      {/* The decision, framed as one: whether students are offered Wise at
          all. It sits in its own bordered row rather than as a bare checkbox
          above the fields, because it is a different KIND of control from the
          three values under it. */}
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-4">
        <Checkbox
          id="wise-enabled"
          name="enabled"
          value="true"
          defaultChecked={props.enabled}
          disabled={pending}
          aria-describedby="wise-enabled-hint"
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor="wise-enabled" className="text-sm leading-snug font-medium">
            {t("web.settings.payments.wiseEnableLabel")}
          </Label>
          <p id="wise-enabled-hint" className="text-sm text-muted-foreground">
            {t("web.settings.payments.wiseEnableHint")}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wise-handle">{t("web.settings.payments.wisetagLabel")}</Label>
        <Input
          id="wise-handle"
          name="handle"
          placeholder={t("web.settings.payments.wisetagPlaceholder")}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="text"
          disabled={pending}
          invalid={Boolean(state?.error)}
          aria-describedby={`${previewId}${state?.error ? ` ${errorId}` : ""}`}
        />
        <p className="text-sm text-muted-foreground">{t("web.settings.payments.wisetagHint")}</p>
        {/* The link itself, live, on its own ground so it reads as the RESULT
            of the field above rather than as a third sentence of help.
            `aria-live` off deliberately: the field points at it through
            aria-describedby, so a screen reader reaches it on focus instead of
            being interrupted once per keystroke. */}
        <p id={previewId} className="rounded-md bg-muted/60 px-3 py-2 text-xs">
          {trimmed && handleValid ? (
            <a
              className="inline-flex items-center gap-1.5 font-mono break-all text-primary underline underline-offset-4"
              href={`${WISE_PAY_BASE_URL}${encodeURIComponent(trimmed)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {`${WISE_PAY_BASE_URL}${trimmed}`}
              <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">{t("web.settings.payments.wisePreviewLabel")}</span>
            </a>
          ) : trimmed ? (
            // Typed something Wise would reject. Said here, before a round
            // trip, rather than only as the server's error after Save.
            <span className="text-warning">{t("web.settings.payments.wisetagInvalid")}</span>
          ) : (
            <span className="font-mono break-all text-muted-foreground">{WISE_PAY_BASE_URL}</span>
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wise-account-holder">{t("web.settings.payments.accountHolderLabel")}</Label>
        <Input
          id="wise-account-holder"
          name="accountHolder"
          placeholder={t("web.settings.payments.accountHolderPlaceholder")}
          defaultValue={props.accountHolder ?? ""}
          maxLength={120}
          autoComplete="off"
          disabled={pending}
          aria-describedby="wise-account-holder-hint"
        />
        <p id="wise-account-holder-hint" className="text-sm text-muted-foreground">
          {t("web.settings.payments.accountHolderHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wise-email">{t("web.settings.payments.wiseEmailLabel")}</Label>
        <Input
          id="wise-email"
          name="email"
          type="email"
          placeholder={t("web.settings.payments.wiseEmailPlaceholder")}
          defaultValue={props.email ?? ""}
          autoComplete="off"
          disabled={pending}
        />
      </div>

      {state?.error && (
        <p id={errorId} role="alert" aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      {/* No success line: the action redirects to `?wise=1`, and the page
          renders its own banner from that. A second confirmation here would
          be a copy of it that can disagree. */}
      <Button type="submit" disabled={pending}>
        {pending ? t("web.settings.payments.savingWise") : t("web.settings.payments.saveWise")}
      </Button>
    </form>
  );
}
