"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  countryFromTimezone,
  defaultPricingCurrencyForCountry,
  DEFAULT_TEACHER_COUNTRY,
  languageOptions,
  pricingCurrenciesForCountry,
  timezoneSchema,
  zodFieldErrors,
} from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { PhoneNumberField } from "@/components/phone-number-field";
import { saveTimezoneAction, type OnboardingState } from "@/app/actions/onboarding";
import { useT, useLocale } from "@/components/locale-provider";
import { useFieldErrors } from "@/hooks/use-field-errors";

// Best-effort country guess for prefill: the detected IANA timezone first (the
// strongest location signal), then the browser's language region. Returns a
// code only when it's in our option list, else null.
function detectCountry(detectedTz: string | null, validCodes: Set<string>): string | null {
  const fromTz = detectedTz ? countryFromTimezone(detectedTz) : null;
  if (fromTz && validCodes.has(fromTz)) return fromTz;
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (region && validCodes.has(region)) return region;
  } catch {
    // Intl.Locale unsupported or malformed language tag — no locale-based guess.
  }
  return null;
}

export function TimezoneForm({
  initialTimezone,
  initialPhoneE164,
  initialCountry,
  initialPricingCurrency,
  initialTargetLanguage,
  options,
  countries,
}: {
  initialTimezone: string;
  initialPhoneE164: string | null;
  initialCountry: string;
  initialPricingCurrency: string;
  initialTargetLanguage: string | null;
  options: string[];
  countries: Array<{ code: string; label: string }>;
}) {
  const t = useT();
  const locale = useLocale();
  const { errors, setErrors, clearError } = useFieldErrors<
    "timezone" | "phoneE164" | "targetLanguage"
  >();
  const [country, setCountry] = useState<string>(initialCountry);
  const [pricingCurrency, setPricingCurrency] = useState<string>(initialPricingCurrency);
  const currencyOptions = useMemo(() => pricingCurrenciesForCountry(country), [country]);
  // Until the teacher picks a currency herself, keep it pinned to the
  // selected country's own currency (defaultPricingCurrencyForCountry — GB ->
  // GBP, MX -> MXN, ...); a country with no curated match just falls back to
  // the rail's first option. `currencyTouched` starts true only when the
  // stored value already diverges from what the initial country would
  // naturally default to — i.e. a teacher who deliberately chose something
  // other than their country's own currency keeps that choice on reload,
  // instead of this effect silently overwriting it back.
  const [currencyTouched, setCurrencyTouched] = useState(
    () =>
      (defaultPricingCurrencyForCountry(initialCountry) ??
        pricingCurrenciesForCountry(initialCountry)[0]) !== initialPricingCurrency,
  );
  useEffect(() => {
    setPricingCurrency((prev) => {
      if (!currencyOptions.includes(prev)) {
        return defaultPricingCurrencyForCountry(country) ?? currencyOptions[0];
      }
      if (!currencyTouched) {
        return defaultPricingCurrencyForCountry(country) ?? currencyOptions[0];
      }
      return prev;
    });
  }, [country, currencyOptions, currencyTouched]);
  const [detected, setDetected] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setDetected(null);
    }
  }, []);

  const merged = useMemo(() => {
    const set = new Set(options);
    if (detected) set.add(detected);
    if (initialTimezone) set.add(initialTimezone);
    return Array.from(set).sort();
  }, [options, detected, initialTimezone]);

  const [state, formAction, pending] = useActionState<OnboardingState, FormData>(
    saveTimezoneAction,
    undefined,
  );

  const [value, setValue] = useState<string>(initialTimezone);
  const [phone, setPhone] = useState<string>(initialPhoneE164 ?? "");
  // Independent of the payout `country` above — a phone number can carry a
  // different country's calling code than where the teacher's based for
  // payouts, so the two must never be locked together. Seeded from the same
  // initial guess, but never synced afterward.
  const [phoneCountry, setPhoneCountry] = useState<string>(initialCountry);
  // The language she TEACHES (D-72's `targetLanguage`), asked here rather than
  // left to Settings — see D-112. Deliberately NOT prefilled from the browser
  // locale or the country: neither is evidence of what she teaches (a Mexican
  // teacher of French would get "Spanish" from both), and a wrong default she
  // has to notice is worse than an empty required field she has to answer.
  const [targetLanguage, setTargetLanguage] = useState<string>(initialTargetLanguage ?? "");
  const languageComboOptions = useMemo(
    () => languageOptions(locale).map((l) => ({ value: l.code, label: l.label })),
    [locale],
  );

  const countryCodes = useMemo(() => new Set(countries.map((c) => c.code)), [countries]);
  const countryComboOptions = useMemo(
    () => countries.map((c) => ({ value: c.code, label: c.label })),
    [countries],
  );
  // Prefill the country from the detected timezone / locale, but only while the
  // teacher hasn't chosen yet (still the "MX" default) — never override a real
  // pick. Mirrors the timezone auto-detect above.
  useEffect(() => {
    if (initialCountry !== DEFAULT_TEACHER_COUNTRY) return;
    const guess = detectCountry(detected, countryCodes);
    if (guess) setCountry(guess);
  }, [detected, countryCodes, initialCountry]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // Same schema the action enforces — an empty/invalid timezone or a missing
    // phone lands next to its own field instead of only as a form-level error.
    const parsed = timezoneSchema(locale).safeParse({
      timezone: value,
      phoneE164: phone,
      country,
      pricingCurrency,
      phoneCountry,
      // Blank means "not chosen": the schema field is optional, so send
      // undefined rather than "" and let the
      // required check below own the empty case.
      targetLanguage: targetLanguage || undefined,
    });
    if (!parsed.success) {
      event.preventDefault();
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    // Required at the form, optional on the wire — see the schema comment. The
    // action enforces the same rule server-side; this is what puts the message
    // next to the field instead of at the bottom of the form.
    if (!targetLanguage) {
      event.preventDefault();
      setErrors({ targetLanguage: t("web.onboarding.timezone.targetLanguageRequired") });
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="country">{t("web.onboarding.timezone.country")}</Label>
        <Combobox
          id="country"
          name="country"
          value={country}
          onValueChange={setCountry}
          options={countryComboOptions}
          placeholder={t("web.onboarding.timezone.countryPlaceholder")}
          searchPlaceholder={t("web.onboarding.timezone.countrySearchPlaceholder")}
          emptyText={t("web.onboarding.timezone.countryEmpty")}
        />
        <p className="text-xs text-muted-foreground">{t("web.onboarding.timezone.countryHint")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pricingCurrency">{t("web.onboarding.timezone.pricingCurrency")}</Label>
        <Select
          name="pricingCurrency"
          value={pricingCurrency}
          onValueChange={(v) => {
            setPricingCurrency(v);
            setCurrencyTouched(true);
          }}
        >
          <SelectTrigger id="pricingCurrency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {currencyOptions.map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("web.onboarding.timezone.pricingCurrencyHint")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="targetLanguage">
          {t("web.onboarding.timezone.targetLanguage")}{" "}
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        </Label>
        <Combobox
          id="targetLanguage"
          name="targetLanguage"
          value={targetLanguage}
          onValueChange={(v) => {
            setTargetLanguage(v);
            clearError("targetLanguage");
          }}
          options={languageComboOptions}
          placeholder={t("web.onboarding.timezone.targetLanguagePlaceholder")}
          searchPlaceholder={t("web.settings.targetLanguage.search")}
          emptyText={t("web.settings.targetLanguage.empty")}
          aria-invalid={errors.targetLanguage ? true : undefined}
          aria-describedby={errors.targetLanguage ? "targetLanguage-field-error" : undefined}
        />
        <p className="text-xs text-muted-foreground">
          {t("web.onboarding.timezone.targetLanguageHint")}
        </p>
        <FieldError id="targetLanguage-field-error" message={errors.targetLanguage} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="timezone">{t("onboarding.timezone.title")}</Label>
        {detected && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{t("web.onboarding.timezone.detected")}</span>
            <Badge variant="secondary">{detected}</Badge>
            {detected !== value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-0.5 text-sm"
                onClick={() => setValue(detected)}
              >
                {t("web.onboarding.timezone.useIt")}
              </Button>
            )}
          </p>
        )}
        <Select
          name="timezone"
          value={value}
          onValueChange={(v) => {
            setValue(v);
            clearError("timezone");
          }}
        >
          <SelectTrigger
            id="timezone"
            aria-invalid={errors.timezone || state?.error ? true : undefined}
            aria-describedby={
              errors.timezone ? "timezone-field-error" : state?.error ? "timezone-error" : undefined
            }
          >
            <SelectValue placeholder={t("web.onboarding.timezone.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {merged.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError id="timezone-field-error" message={errors.timezone} />
      </div>
      <PhoneNumberField
        id="phoneE164"
        phoneName="phoneE164"
        phone={phone}
        onPhoneChange={(v) => {
          setPhone(v);
          clearError("phoneE164");
        }}
        countryName="phoneCountry"
        country={phoneCountry}
        onCountryChange={setPhoneCountry}
        label={
          <>
            {t("onboarding.timezone.phoneLabel")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </>
        }
        placeholder="55 1234 5678"
        hint={t("onboarding.timezone.phoneHint")}
        required
        countryAriaLabel={t("web.phoneCountrySelect.label")}
        countryPlaceholder={t("web.onboarding.timezone.countryPlaceholder")}
        countrySearchPlaceholder={t("web.onboarding.timezone.countrySearchPlaceholder")}
        countryEmptyText={t("web.onboarding.timezone.countryEmpty")}
      />
      <FieldError id="phoneE164-error" message={errors.phoneE164} />
      {state?.error && (
        <p id="timezone-error" role="alert" aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? t("web.onboarding.saving") : t("common.continue")}
      </Button>
    </form>
  );
}
