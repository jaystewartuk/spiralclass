"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneNumberField } from "@/components/phone-number-field";
import { useT } from "@/components/locale-provider";
import { captureLead, type LeadCaptureState } from "@/app/actions/leads";
import { currentSessionId } from "@/lib/analytics/posthog-browser";
import { CheckCircle2 } from "lucide-react";

// Lead capture for visitors who land on the public booking page but aren't ready
// to buy yet (docs/features/student-acquisition.md). Mirrors the checkout
// form's plumbing — a hidden PostHog session id refreshed at submit so the
// captured event can stitch onto the session recording. On success the form
// swaps to a thank-you so the visitor gets clear confirmation the teacher will
// be in touch. `defaultCountry` prefills the phone-country picker with the
// booking-page teacher's own country (a same-market guess, always
// overridable) — visitors have no first-class country of their own.
export function LeadForm({ slug, defaultCountry }: { slug: string; defaultCountry: string }) {
  const t = useT();
  const [state, formAction, pending] = useActionState<LeadCaptureState, FormData>(
    captureLead,
    undefined,
  );
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState(defaultCountry);

  const sessionIdRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sessionIdRef.current) {
      sessionIdRef.current.value = currentSessionId() ?? "";
    }
  }, []);

  if (state?.ok) {
    return (
      <div className="border-success/30 bg-success-bg flex items-start gap-3 rounded-md border p-4 text-sm">
        <CheckCircle2 className="text-success mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <p>{t("web.leadForm.thanks")}</p>
      </div>
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
      className="space-y-3"
    >
      <input type="hidden" name="slug" value={slug} />
      <input ref={sessionIdRef} type="hidden" name="posthogSessionId" defaultValue="" />

      {/* Honeypot — captureLead() silently discards any submission that fills
          this in. Deliberately NOT `type="hidden"`: bots skip hidden inputs,
          so it has to look like a real field to a form parser while being
          unreachable to a human. `name="website"` is the bait (the attribute
          form-fillers match on); `aria-hidden` + tabIndex -1 keep it out of
          screen readers and keyboard tabbing, and it carries no visible label
          precisely because no human should ever perceive it. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <input
          id="lead-website"
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="lead-name">
          {t("web.leadForm.yourName")}{" "}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </Label>
        <Input id="lead-name" name="name" required maxLength={80} autoComplete="name" />
      </div>

      <div className="space-y-1">
        <Label htmlFor="lead-email">
          {t("common.email")}{" "}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </Label>
        <Input id="lead-email" name="email" type="email" required autoComplete="email" />
      </div>

      <PhoneNumberField
        id="lead-phone"
        phoneName="phone"
        phone={phone}
        onPhoneChange={setPhone}
        countryName="phoneCountry"
        country={phoneCountry}
        onCountryChange={setPhoneCountry}
        label={t("web.leadForm.phoneOptional")}
        placeholder="55 1234 5678"
        countryAriaLabel={t("web.phoneCountrySelect.label")}
        countryPlaceholder={t("web.phoneCountrySelect.placeholder")}
        countrySearchPlaceholder={t("web.phoneCountrySelect.searchPlaceholder")}
        countryEmptyText={t("web.phoneCountrySelect.noResults")}
      />

      <div className="space-y-1">
        <Label htmlFor="lead-message">{t("web.leadForm.messageOptional")}</Label>
        <textarea
          id="lead-message"
          name="message"
          rows={3}
          maxLength={1000}
          placeholder={t("web.leadForm.messagePlaceholder")}
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-16 w-full rounded-md border px-3 py-2 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {state?.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t("web.leadForm.sending") : t("web.leadForm.send")}
      </Button>
    </form>
  );
}
