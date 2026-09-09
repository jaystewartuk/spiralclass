"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import {
  createT,
  currencyForTeacher,
  isConnectCountrySupported,
  majorToMinorUnits,
  type StringKey,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { requireTeacher } from "@/lib/auth";
import { getPreferredLocale, type AppLocale } from "@/lib/i18n";
import { availabilitySchema, templatesSchema, timezoneSchema } from "@/lib/validators";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { ensureTeacherFocusTags } from "@/lib/focus-tags";
import { gateTemplateSet, upgradeNudge } from "@/lib/subscriptions/enforce";
import { normalizeE164 } from "@/lib/phone";
import { maybeEmitMarketplaceReady } from "@/lib/marketplace-ready";

// `templateIndex` (when present) points the templates form at the offending
// package card so the error highlights the right row, not always the first.
// `field` (availability) names the offending input group — "bufferMin",
// "minAdvanceH", "maxAdvanceDays", or "ranges" — so the form highlights the
// right control instead of always reddening the first numeric field.
export type OnboardingState =
  | {
      error?: string;
      templateIndex?: number;
      field?: string;
      /**
       * Set by a SETTINGS save, which returns rather than redirecting: the
       * wizard's next step is a different page, but /settings/templates is the
       * page she is already on and working in. Redirecting there threw away her
       * scroll position and every open package card to tell her the save
       * worked; returning lets the editor say so in place and re-baseline its
       * unsaved-changes model.
       */
      ok?: boolean;
      /** The saved set, so a row created this session adopts its server id and
       * a second save updates it instead of creating a duplicate. */
      templates?: SavedTemplate[];
    }
  | undefined;

/** The shape /settings/templates re-seeds its editor from after a save.
 * Deliberately the columns the form owns — nothing derived, nothing the
 * client would have to know how to recompute. */
export type SavedTemplate = {
  id: string;
  name: string;
  subject: string | null;
  classCount: number;
  singleClass: boolean;
  classDurationMin: number;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
  expirationMonths: number | null;
};

// Mon-first labels, keyed by weekday value (0 = Sunday .. 6 = Saturday), used
// to prefix a range-level availability error with the day it belongs to.
const WEEKDAY_LABELS: Record<number, { es: string; en: string }> = {
  1: { es: "Lunes", en: "Monday" },
  2: { es: "Martes", en: "Tuesday" },
  3: { es: "Miércoles", en: "Wednesday" },
  4: { es: "Jueves", en: "Thursday" },
  5: { es: "Viernes", en: "Friday" },
  6: { es: "Sábado", en: "Saturday" },
  0: { es: "Domingo", en: "Sunday" },
};

function weekdayLabel(weekday: number, en: boolean): string | undefined {
  const label = WEEKDAY_LABELS[weekday];
  if (!label) return undefined;
  return en ? label.en : label.es;
}

export async function saveTimezoneAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = timezoneSchema(locale).safeParse({
    timezone: formData.get("timezone"),
    phoneE164: formData.get("phoneE164"),
    country: formData.get("country") ?? undefined,
    pricingCurrency: formData.get("pricingCurrency") ?? undefined,
    phoneCountry: formData.get("phoneCountry") ?? undefined,
    // The Combobox posts "" when nothing is picked; the schema field is
    // optional, so normalize the empty string away and let the required check
    // below own it.
    targetLanguage: formData.get("targetLanguage") || undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }
  // Required on web, where there is no such thing as a stale client — the
  // form blocks on it too, so reaching this is a hand-crafted POST. Mobile
  // enforces the same rule in its own screen rather than here, because its
  // shipped builds can predate the field (D-112, and the schema comment).
  if (!parsed.data.targetLanguage) {
    return {
      error: en ? "Pick the language you teach." : "Elige el idioma que enseñas.",
    };
  }
  // Stripe fixes a connected account's country permanently at creation
  // (comment on `Teacher.country` in schema.prisma) — once a live Connect
  // account exists, changing this field would desync our record from what
  // Stripe actually has on file, not just move the teacher in/out of the
  // payout circle. This route is the only place `country` is ever written.
  if (teacher.stripeAccountId && parsed.data.country && parsed.data.country !== teacher.country) {
    return {
      error: en
        ? "You can't change your country after connecting Stripe. Disconnect Stripe first if you need to."
        : "No puedes cambiar tu país después de conectar Stripe. Desconecta Stripe primero si lo necesitas.",
    };
  }
  // The phone's country is picked independently of the payout `country`
  // above — a teacher can be based in one country and carry a phone number
  // from another, so the two must never be locked together.
  const phoneE164 = parsed.data.phoneE164
    ? normalizeE164(
        parsed.data.phoneE164,
        parsed.data.phoneCountry ?? parsed.data.country ?? teacher.country,
      )
    : null;
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: {
      timezone: parsed.data.timezone,
      // Always overwrite (including with null) so the teacher can clear it
      // by submitting an empty field. The class detail page nudges silently fall back to
      // email when null, matching the dispatcher's resolveChannel behavior.
      phoneE164,
      // Only overwrite country when the form sent one (it always does today);
      // an omitted field leaves the "MX" column default in place rather than
      // nulling ground truth.
      ...(parsed.data.country ? { country: parsed.data.country } : {}),
      // Same posture as country: only overwrite when sent, and only before
      // onboarding completes in practice (the stepper never revisits this
      // page afterward) — a self-service change post-onboarding is out of
      // scope (D-64), same as country today.
      ...(parsed.data.pricingCurrency ? { pricingCurrency: parsed.data.pricingCurrency } : {}),
      // What she teaches (D-72). Same only-when-sent posture as the two above.
      ...(parsed.data.targetLanguage ? { targetLanguage: parsed.data.targetLanguage } : {}),
    },
  });

  // Re-stamp the STARTER availability rules with the zone she just declared.
  //
  // Provisioning seeds those rows before anything is known about where she is
  // (lib/auth.ts, FALLBACK_TIMEZONE), and
  // step 2 of onboarding only rewrites them when she actually submits the
  // availability form. A teacher who completes this step and never touches
  // step 2 was therefore left with rules frozen in the seed zone while her
  // profile said otherwise — so her bookable slots were computed against a
  // wall clock that was not hers. Guarded on `availabilityTouchedAt`: once she
  // has submitted real hours, D-53's freeze applies and these rows are hers,
  // never ours to reinterpret.
  if (!teacher.availabilityTouchedAt) {
    await prisma.availabilityRule.updateMany({
      where: { teacherId: teacher.id },
      data: { timezone: parsed.data.timezone },
    });
  }

  // Seed the focus-tag pack for the chosen language NOW, at the first step of
  // onboarding, which is the whole point of asking here (D-112). The seeder is
  // lazy — `getTeacherFocusTags` self-seeds on the first empty read — so
  // whichever value is stored when the focus picker first renders is the pack
  // she gets, permanently: D-20 seeding is additive, so a language set after
  // that read stacks its pack on top of the generic one instead of replacing
  // it. Seeding here means the read never happens with a null language.
  // Best-effort and idempotent, exactly as in `saveTargetLanguageAction`.
  if (parsed.data.targetLanguage) {
    await ensureTeacherFocusTags(teacher.id, parsed.data.targetLanguage, locale).catch(() => {});
  }

  // Onboarding-funnel analytics, from the activation audit: this action has
  // no Settings-reuse path, so every call is genuinely part of the wizard.
  // `onboarding_started` fires only on what looks like a first pass (neither
  // later step touched yet) — not exact (no dedicated startedAt marker), but
  // keeps a teacher revisiting step 1 via the stepper nav from re-inflating
  // the funnel's denominator.
  if (
    !teacher.availabilityTouchedAt &&
    !teacher.templatesTouchedAt &&
    !teacher.onboardingCompleteAt
  ) {
    trackServerEvent({
      name: "onboarding_started",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id },
    });
  }
  trackServerEvent({
    name: "onboarding_step_completed",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, step: "timezone" },
  });
  await flushAnalytics();

  revalidatePath("/onboarding", "layout");
  redirect("/onboarding/availability");
}

export async function saveAvailabilityAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  // Ranges come as parallel arrays: ranges[i][weekday], ranges[i][startTime], ranges[i][endTime].
  const weekdays = formData.getAll("range_weekday") as string[];
  const starts = formData.getAll("range_start") as string[];
  const ends = formData.getAll("range_end") as string[];

  const ranges = weekdays.map((weekday, i) => ({
    weekday,
    startTime: starts[i] ?? "",
    endTime: ends[i] ?? "",
  }));

  const parsed = availabilitySchema(locale).safeParse({
    bufferMin: formData.get("bufferMin"),
    minAdvanceH: formData.get("minAdvanceH"),
    maxAdvanceDays: formData.get("maxAdvanceDays"),
    ranges,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
    // For a range-level problem, name the day so "This time range overlaps…"
    // isn't a mystery when the teacher has several days configured. path is
    // ["ranges", index, ...]; ranges[index] still carries the raw weekday.
    const rangeIndex =
      field === "ranges" && typeof issue?.path[1] === "number" ? issue.path[1] : undefined;
    const dayLabel =
      rangeIndex !== undefined ? weekdayLabel(Number(ranges[rangeIndex]?.weekday), en) : undefined;
    const baseMessage = issue?.message ?? (en ? "Invalid schedule" : "Horario inválido");
    return {
      error: dayLabel ? `${dayLabel}: ${baseMessage}` : baseMessage,
      field,
    };
  }

  await prisma.$transaction([
    prisma.teacher.update({
      where: { id: teacher.id },
      data: {
        bufferMin: parsed.data.bufferMin,
        minAdvanceH: parsed.data.minAdvanceH,
        maxAdvanceDays: parsed.data.maxAdvanceDays,
        // A real submit here — wizard
        // step 2 or Settings → Availability — counts as reviewed, distinct
        // from the untouched starter-availability seed.
        availabilityTouchedAt: new Date(),
      },
    }),
    prisma.availabilityRule.deleteMany({ where: { teacherId: teacher.id } }),
    prisma.availabilityRule.createMany({
      data: parsed.data.ranges.map((r) => ({
        teacherId: teacher.id,
        weekday: r.weekday,
        startTime: r.startTime,
        endTime: r.endTime,
        // Freeze the zone these wall-clock times were written in (D-53). The
        // teacher is declaring these hours in their current zone; a later
        // relocation + zone change must not silently reinterpret them.
        timezone: teacher.timezone,
      })),
    }),
  ]);

  trackServerEvent({
    name: "availability_configured",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, rangesCount: parsed.data.ranges.length },
  });

  // Whitelist of post-save targets so the form can be reused outside the
  // onboarding wizard without enabling open-redirect. The settings redirect
  // carries ?saved=1 so the page surfaces a "guardado" confirmation —
  // without it, the form refresh looks like a no-op to the teacher.
  const next = formData.get("redirectTo");
  const fromOnboarding = next !== "/settings/availability";
  if (fromOnboarding) {
    trackServerEvent({
      name: "onboarding_step_completed",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, step: "availability" },
    });
  }
  await flushAnalytics();
  await maybeEmitMarketplaceReady(prisma, teacher.id);

  const target = fromOnboarding ? "/onboarding/templates" : "/settings/availability?saved=1";
  revalidatePath("/", "layout");
  redirect(target);
}

// Turn the first Zod issue into a teacher-readable, package-numbered message
// and surface which card to highlight. The schema emits stable field tokens
// (e.g. "name_required") with a path of ["templates", index, field]; we map
// both here so the copy stays localized in one place.
// Which catalog string names each field's rule. Keys rather than an inline
// `en ? ... : ...`: that ternary had exactly two branches on a platform with
// three locales, so a French teacher was answered in Spanish — and the rules
// themselves live in `packageTemplateSchema`, shared with mobile, while their
// wording did not live anywhere a translator could find it.
const TEMPLATE_ERROR_KEYS: Record<string, StringKey> = {
  name: "templates.error.name",
  classCount: "templates.error.classCount",
  classDurationMin: "templates.error.duration",
  priceMinorUnits: "templates.error.price",
  expirationMonths: "templates.error.expiration",
};

function describeTemplateError(
  error: ZodError,
  locale: AppLocale,
): { error: string; templateIndex?: number } {
  const t = createT(locale);
  const issue = error.issues[0];
  const path = issue?.path ?? [];
  const index = typeof path[1] === "number" ? path[1] : undefined;
  const field = String(path[path.length - 1] ?? "");
  const pkg = t("web.onboarding.templates.packageN", { n: (index ?? 0) + 1 });
  const key = TEMPLATE_ERROR_KEYS[field] ?? "templates.error.generic";
  return { error: t(key, { package: pkg }), templateIndex: index };
}

export async function saveTemplatesAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();

  const ids = formData.getAll("tpl_id") as string[];
  const names = formData.getAll("tpl_name") as string[];
  const subjects = formData.getAll("tpl_subject") as string[];
  const singleClasses = formData.getAll("tpl_single_class") as string[];
  const classCounts = formData.getAll("tpl_class_count") as string[];
  const durations = formData.getAll("tpl_duration") as string[];
  const prices = formData.getAll("tpl_price") as string[]; // major units, we convert to minor units
  // Optional per-template Wise price. Empty string → undefined → falls
  // back to the Stripe price at checkout. We never store 0 to mean
  // "fallback" — that would make a free Wise checkout impossible to express.
  const wisePrices = formData.getAll("tpl_wise_price") as string[];
  const expirations = formData.getAll("tpl_expiration") as string[];
  const keeps = formData.getAll("tpl_keep") as string[]; // "1" if the keep checkbox was checked

  // A teacher outside the Stripe Connect payout circle has no card rail at all
  // (D-58), so there is no "Stripe price" for a Wise price to be a discount
  // OFF. TemplatesForm already hides the whole split for her and shows a single
  // plain "Price" — but hiding a control is not the same as clearing its value,
  // and the hidden input kept resubmitting whatever `transferPriceMinorUnits` was
  // already on the row.
  //
  // That is not cosmetic: checkout charges `transferPriceMinorUnits ?? priceMinorUnits`
  // (lib/payments/instruments.ts), so a stale value became the real price and
  // was UNREACHABLE — the live Mexican teacher's booking page advertised
  // 2,600 / 1,450 / 6,400 while the transfer rail took 2,500 / 1,300 / 6,000,
  // with no field anywhere in the product that could change it.
  //
  // Enforced here rather than only in the form, because the form is one client
  // and this is the invariant: no card rail, no second price.
  const wiseSplitAvailable = isConnectCountrySupported(teacher.country);

  const currency = currencyForTeacher(teacher);
  const rows = ids.map((id, i) => ({
    id: id || undefined,
    name: names[i] ?? "",
    subject: subjects[i] ?? "",
    singleClass: singleClasses[i] === "1",
    classCount: classCounts[i],
    classDurationMin: durations[i] || 50,
    // Her own pricing currency, never the MXN default: `majorToMinorUnits`
    // rounds to the currency's exponent, so omitting it multiplies a
    // 0-decimal price (CLP, JPY, KRW, VND) by 100.
    priceMinorUnits: majorToMinorUnits(Number(prices[i] ?? 0), currency),
    transferPriceMinorUnits:
      wiseSplitAvailable && wisePrices[i] && wisePrices[i] !== ""
        ? majorToMinorUnits(Number(wisePrices[i]), currency)
        : undefined,
    expirationMonths: expirations[i] ? Number(expirations[i]) : null,
    keep: keeps[i] === "1",
  }));

  const parsed = templatesSchema.safeParse({ templates: rows });
  if (!parsed.success) {
    return describeTemplateError(parsed.error, locale);
  }

  // Free-cap enforcement (replace-set aware): a Free teacher can't raise the
  // active template count past the cap. New teachers are on the Pro trial, so
  // this is a no-op during onboarding; it bites a downgraded Free teacher who
  // tries to add a second template later. Grandfathers existing over-cap rows.
  const resultingActive = parsed.data.templates.filter((t) => t.keep).length;
  const existingActive = await prisma.packageTemplate.count({
    where: { teacherId: teacher.id, archived: false },
  });
  const tplGate = await gateTemplateSet(teacher.id, resultingActive, existingActive);
  if (!tplGate.ok) {
    return { error: upgradeNudge(tplGate.limit, locale) };
  }

  const createdTemplateIds: string[] = [];
  // Currency for this teacher's templates — their own chosen pricing
  // currency, never hardcoded.
  const teacherCurrency = currencyForTeacher(teacher);
  await prisma.$transaction(async (tx) => {
    // A real submit here — wizard step
    // 3 or Settings → Packages — counts as the teacher having reviewed/
    // customized their offer, distinct from the untouched starter-template seed.
    await tx.teacher.update({
      where: { id: teacher.id },
      data: { templatesTouchedAt: new Date() },
    });
    for (const t of parsed.data.templates) {
      if (!t.id) {
        // Id-less + unkeep is a row the teacher created and then deleted in
        // the same form submission — nothing to persist.
        if (!t.keep) continue;
        const created = await tx.packageTemplate.create({
          data: {
            teacherId: teacher.id,
            name: t.name,
            subject: t.subject,
            singleClass: t.singleClass,
            classCount: t.classCount,
            classDurationMin: t.classDurationMin,
            priceMinorUnits: t.priceMinorUnits,
            currency: teacherCurrency,
            transferPriceMinorUnits: t.transferPriceMinorUnits ?? null,
            expirationMonths: t.expirationMonths ?? null,
          },
          select: { id: true },
        });
        createdTemplateIds.push(created.id);
        continue;
      }
      // Scope the write by teacher_id (tenant isolation): `t.id` is client-supplied, so a
      // plain `update`/`where: { id }` let a teacher archive or rewrite ANOTHER
      // teacher's template by posting a foreign id. updateMany with the
      // teacher-scoped WHERE makes a foreign id match 0 rows (a silent no-op)
      // instead of mutating cross-tenant.
      if (!t.keep) {
        await tx.packageTemplate.updateMany({
          where: { id: t.id, teacherId: teacher.id },
          data: { archived: true },
        });
        continue;
      }
      await tx.packageTemplate.updateMany({
        where: { id: t.id, teacherId: teacher.id },
        data: {
          name: t.name,
          subject: t.subject,
          singleClass: t.singleClass,
          classCount: t.classCount,
          classDurationMin: t.classDurationMin,
          priceMinorUnits: t.priceMinorUnits,
          transferPriceMinorUnits: t.transferPriceMinorUnits ?? null,
          expirationMonths: t.expirationMonths ?? null,
          archived: false,
        },
      });
    }
  });

  // package_template_created previously fired only for the starter templates
  // seeded at signup (lib/auth.ts); a template a teacher adds later — here or
  // via the mobile templates editor — went uncounted. Emit one per newly
  // created row so the metric reflects real catalog growth on both surfaces.
  for (const templateId of createdTemplateIds) {
    trackServerEvent({
      name: "package_template_created",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, templateId, source: "teacher_created" },
    });
  }

  const next = formData.get("redirectTo");
  const fromOnboarding = next !== "/settings/templates";
  if (fromOnboarding) {
    trackServerEvent({
      name: "onboarding_step_completed",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, step: "templates" },
    });
  }
  // Flush once after the loop, never per-iteration.
  await flushAnalytics();
  await maybeEmitMarketplaceReady(prisma, teacher.id);

  revalidatePath("/", "layout");
  if (fromOnboarding) redirect("/onboarding/preview");

  // Settings stays put and re-seeds the editor from what was actually written.
  // Two reasons it reads the set back rather than echoing the parsed input:
  // a row created this session has no id until now, and the teacher-scoped
  // `updateMany` above silently no-ops on a foreign id — so the parsed input
  // is what she ASKED for, and this is what the database holds.
  const saved = await prisma.packageTemplate.findMany({
    where: { teacherId: teacher.id, archived: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      subject: true,
      classCount: true,
      singleClass: true,
      classDurationMin: true,
      priceMinorUnits: true,
      transferPriceMinorUnits: true,
      expirationMonths: true,
    },
  });
  return { ok: true, templates: saved };
}

export async function finishOnboardingAction() {
  const teacher = await requireTeacher();
  const alreadyFinished = Boolean(teacher.onboardingCompleteAt);
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { onboardingCompleteAt: teacher.onboardingCompleteAt ?? new Date() },
  });

  // "Baseline Configured" in the activation model — NOT the same as
  // marketplace_ready, which requires a real profile + reviewed offer/schedule
  // + a connected payout rail on top of this. Guarded so revisiting the
  // preview step and re-submitting Finish doesn't re-fire the funnel event.
  if (!alreadyFinished) {
    trackServerEvent({
      name: "onboarding_step_completed",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, step: "preview" },
    });
    trackServerEvent({
      name: "onboarding_finished",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id },
    });
    await flushAnalytics();
  }
  await maybeEmitMarketplaceReady(prisma, teacher.id);

  revalidatePath("/", "layout");
  redirect("/dashboard");
}
