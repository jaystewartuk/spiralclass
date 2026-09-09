"use client";

import { useMemo, type ReactNode } from "react";
import { phoneCountryOptions } from "@spiralclass/shared";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/components/locale-provider";

// A phone number is really two parts — a calling code and a national
// number — but this used to render as two stacked, unrelated-looking
// controls: a free-text phone <Input> whose placeholder invited typing
// "+52" by hand, plus a separate "Phone country" picker below it. Nothing
// tied them together visually, and a person could pick one country while
// pasting a number that already carries a different "+" code
// (normalizeE164 trusts an explicit "+" over the picker, silently). This
// renders them as one bordered field — a compact dial-code chip on the
// left, the bare national number on the right — like Stripe/most phone
// widgets, matching what the person is actually meant to type: national
// digits only, never a "+".
export function PhoneNumberField({
  id,
  phoneName,
  phone,
  onPhoneChange,
  countryName,
  country,
  onCountryChange,
  label,
  placeholder,
  hint,
  countryAriaLabel,
  countryPlaceholder,
  countrySearchPlaceholder,
  countryEmptyText,
  required,
}: {
  id: string;
  phoneName: string;
  phone: string;
  onPhoneChange: (value: string) => void;
  // Omit when another field on the same form already submits the country
  // under its own name (e.g. onboarding's general "Country" combobox) — no
  // need for a second hidden input carrying the identical value.
  countryName?: string;
  country: string;
  onCountryChange: (value: string) => void;
  label: ReactNode;
  placeholder: string;
  hint?: string;
  countryAriaLabel: string;
  countryPlaceholder: string;
  countrySearchPlaceholder: string;
  countryEmptyText: string;
  required?: boolean;
}) {
  const locale = useLocale();
  const options = useMemo(() => phoneCountryOptions(locale), [locale]);
  const selectedDialCode = options.find((o) => o.code === country)?.dialCode;

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {/* No `overflow-hidden` here: the country <Combobox> renders its search +
          country-list popover as an absolutely-positioned child, and an
          `overflow-hidden` ancestor clips it away entirely (the dropdown hangs
          below the field, outside the clip box) — so on web the searchable
          country list never appeared. The two inner controls instead round
          their own outer corners to sit flush inside the rounded border. */}
      <div className="flex rounded-md border border-input bg-transparent shadow-sm focus-within:ring-1 focus-within:ring-ring">
        <Combobox
          name={countryName}
          value={country}
          onValueChange={onCountryChange}
          options={options.map((o) => ({ value: o.code, label: `${o.label} (+${o.dialCode})` }))}
          formatSelected={() => (selectedDialCode ? `+${selectedDialCode}` : "")}
          placeholder={countryPlaceholder}
          searchPlaceholder={countrySearchPlaceholder}
          emptyText={countryEmptyText}
          aria-label={countryAriaLabel}
          // Wide enough for every real dial code ("+" + up to 3 digits, e.g.
          // "+998") plus the chevron — 4.5rem clipped to "+…" once the
          // trigger's own padding + icon ate into the budget.
          className="h-9 w-[5.5rem] shrink-0 rounded-l-md rounded-r-none border-0 border-r border-input text-sm shadow-none focus-visible:ring-0"
        />
        <Input
          id={id}
          name={phoneName}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder={placeholder}
          required={required}
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          className="h-9 rounded-l-none rounded-r-md border-0 text-sm shadow-none focus-visible:ring-0 lg:h-9"
        />
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
