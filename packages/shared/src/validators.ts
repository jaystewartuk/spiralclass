import { z } from "zod";
import type { LocaleCode as AppLocale } from "./api";
import { isLanguageCode } from "./languages";
import { isPricingCurrencySupported } from "./pricing-currency";
import { WISE_HANDLE_RE } from "./payout-instruments";

// Each schema is a factory that takes the caller's locale so Zod's
// per-field error messages render in the user's language. Defaults to
// "en" matching the platform's i18n.ts default.
type Loc = (es: string, en: string) => string;
const t =
  (locale: AppLocale): Loc =>
  (es, en) =>
    locale === "en" ? en : es;

const hhmm = (loc: Loc) =>
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, loc("Formato HH:MM", "Use HH:MM format"));

// Identity emails are normalized (trimmed + lowercased) at every input
// boundary. Supabase lowercases auth emails and Postgres compares text
// case-sensitively, so a mixed-case submission would otherwise mint a
// student row the checkout dedupe can't find again and magic-link sign-in
// can never link. The migration `normalize_student_emails` backfills rows
// written before this rule existed.
const emailField = (loc: Loc) =>
  z.string().trim().toLowerCase().email(loc("Correo inválido", "Invalid email"));

// Hoisted above every schema: the portal checkout schema below is a plain
// top-level object rather than a factory, so it evaluates at module load and
// a later `const` would be in its temporal dead zone.
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
// Same, but also treats null/undefined as absent — what `FormData.get()`
// returns for a field the form did not include.
const nullishToUndef = (v: unknown) => (v == null ? undefined : emptyToUndef(v));

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Passwordless auth (§ auth-model 2026-06-03): teachers and students both
// sign in with an emailed magic link. Sign-up collects a name so the teacher
// row has a sensible display name before onboarding; sign-in is email-only.
export const signUpSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    name: z.string().min(1, loc("Tu nombre es requerido", "Your name is required")).max(80),
    email: emailField(loc),
  });
};
export type SignUpInput = z.infer<ReturnType<typeof signUpSchema>>;

export const signInSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    email: emailField(loc),
  });
};
export type SignInInput = z.infer<ReturnType<typeof signInSchema>>;

// Optional phone-OTP sign-in rail, student-facing and flag-gated. It never
// reached production — the rail was dropped in the better-auth cutover (D-40)
// and this schema is residue.
//
// A phone number is the more universal identity for students in this market; the
// schema mirrors the phone-number rule used elsewhere (E.164-ish digits,
// optional leading +). Normalization to canonical E.164 happens in the action
// via normalizeE164.
const phoneField = (loc: Loc) =>
  z
    .string()
    .trim()
    .regex(/^\+?\d{8,15}$/u, loc("Número de teléfono inválido", "Invalid phone number"));

export const phoneSignInSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({ phone: phoneField(loc) });
};
export type PhoneSignInInput = z.infer<ReturnType<typeof phoneSignInSchema>>;

export const phoneCodeSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    phone: phoneField(loc),
    code: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/u, loc("Código inválido", "Invalid code")),
  });
};
export type PhoneCodeInput = z.infer<ReturnType<typeof phoneCodeSchema>>;

export const timezoneSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    timezone: z
      .string()
      .min(1)
      .refine(isValidTimezone, { message: loc("Zona horaria inválida", "Invalid time zone") }),
    // Teacher-side contact phone, collected so the platform can reach
    // teachers for ops-side nudges. Required at onboarding.
    phoneE164: z
      .string({
        required_error: loc("Tu teléfono es requerido", "Your phone is required"),
      })
      .trim()
      .min(1, loc("Tu teléfono es requerido", "Your phone is required"))
      .regex(/^\+?\d{8,15}$/u, loc("Número de teléfono inválido", "Invalid phone number")),
    // Teacher's country (ISO-3166-1 alpha-2). Optional at the schema layer so
    // clients that predate the field (already-shipped mobile builds) keep
    // working — they omit it and the teacher stays on the "MX" column default.
    // The current onboarding forms always send it. Drives Stripe Connect
    // account creation, which is immutable after creation.
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/u, loc("País inválido", "Invalid country"))
      .optional(),
    // Teacher's pricing currency (ISO-4217), captured alongside country —
    // country decides which curated list (Connect-circle vs Wise-rail, see
    // @spiralclass/shared pricing-currency.ts) the picker offers. Optional at
    // the schema layer for the same reason `country` is: a pre-existing
    // client that predates this field omits it and the teacher stays on the
    // "MXN" column default. Locked after onboarding — see D-64.
    pricingCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isPricingCurrencySupported, loc("Moneda inválida", "Invalid currency"))
      .optional(),
    // ISO-3166-1 alpha-2 hint for resolving a bare national-format phoneE164 —
    // picked independently next to the phone field. Deliberately NOT the same
    // value as `country` above: a teacher's phone number can carry a
    // different country's calling code than the country she's based in for
    // payout purposes (Stripe Connect), so the two must never be locked
    // together. Falls back to `country` (then the teacher's stored country)
    // only when omitted, e.g. a pre-existing client that predates this field.
    phoneCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
    // The language this teacher TEACHES — the subject itself, since the
    // platform is language-first (D-72). A BCP-47 code from the one registry
    // (`languages.ts`), asked here at onboarding step 1 rather than left to
    // Settings, because a null value is not inert: `ensureTeacherFocusTags`
    // seeds the generic pack off it on first read and D-20 seeding is
    // additive, so a language set later stacks its pack on top of the wrong
    // one instead of replacing it (D-112).
    //
    // **Required in both onboarding forms, optional at this schema layer** —
    // deliberately, and for exactly the reason `country`/`pricingCurrency`
    // above are: an already-shipped mobile build predating the field omits it,
    // and a hard requirement here would 422 that client's whole step 1 rather
    // than just leaving the language unset. The web action enforces it
    // server-side (web is never a stale client); mobile enforces it in the
    // screen and picks the rest up on the next OTA.
    targetLanguage: z
      .string()
      .trim()
      .refine(isLanguageCode, loc("Idioma desconocido", "Unknown language"))
      .optional(),
  });
};
export type TimezoneInput = z.infer<ReturnType<typeof timezoneSchema>>;

export const availabilityRangeSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z
    .object({
      weekday: z.coerce.number().int().min(0).max(6),
      startTime: hhmm(loc),
      endTime: hhmm(loc),
    })
    .refine((r) => r.startTime < r.endTime, {
      message: loc(
        "La hora de fin debe ser posterior a la de inicio",
        "End time must be after start time",
      ),
      path: ["endTime"],
    });
};

export const availabilitySchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    bufferMin: z.coerce.number().int().min(0).max(120),
    minAdvanceH: z.coerce.number().int().min(0).max(168),
    maxAdvanceDays: z.coerce.number().int().min(1).max(365),
    ranges: z
      .array(availabilityRangeSchema(locale))
      .min(1, loc("Agrega al menos un horario", "Add at least one time slot"))
      // Reject overlapping ranges on the same day. Two windows that touch at an
      // endpoint (09:00–10:00 and 10:00–11:00) are fine; genuine overlap
      // (09:00–11:00 and 10:00–12:00) would double-count the shared hour and is
      // almost always a mistake. We flag the later-starting range so the error
      // points at the row the teacher most likely just added.
      .superRefine((ranges, ctx) => {
        const byDay = new Map<number, Array<{ range: (typeof ranges)[number]; index: number }>>();
        ranges.forEach((range, index) => {
          const list = byDay.get(range.weekday) ?? [];
          list.push({ range, index });
          byDay.set(range.weekday, list);
        });
        for (const list of byDay.values()) {
          const sorted = [...list].sort((a, b) =>
            a.range.startTime.localeCompare(b.range.startTime),
          );
          for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1].range;
            const curr = sorted[i];
            if (curr.range.startTime < prev.endTime) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [curr.index],
                message: loc(
                  "Este horario se encima con otro del mismo día",
                  "This time range overlaps another on the same day",
                ),
              });
            }
          }
        }
      }),
  });
};
export type AvailabilityInput = z.infer<ReturnType<typeof availabilitySchema>>;

// Blocked dates vacation/holiday blocks. Dates come in as `YYYY-MM-DD` from the
// teacher's local view; the action interprets them as full local-day ranges
// in the teacher's timezone. `endDate` is inclusive (one-day block: same
// start and end date). Reason is optional but encouraged.
export const blockedDateSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, loc("Fecha inválida", "Invalid date")),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, loc("Fecha inválida", "Invalid date")),
      reason: z
        .string()
        .trim()
        .max(120, loc("Motivo demasiado largo", "Reason too long"))
        .optional()
        .or(z.literal("").transform(() => undefined)),
    })
    .refine((b) => b.startDate <= b.endDate, {
      message: loc(
        "La fecha final debe ser igual o posterior a la inicial",
        "End date must be the same as or after the start date",
      ),
      path: ["endDate"],
    });
};
export type BlockedDateInput = z.infer<ReturnType<typeof blockedDateSchema>>;

//: every template is a fixed package with an explicit expiration
// in months. `transferPriceMinorUnits` is optional. When omitted, the Wise
// price falls back to `priceMinorUnits` (same on both rails).
export const packageTemplateSchema = z
  .object({
    id: z.string().optional(),
    // Content fields are permissive at the base layer; the real per-field
    // rules run in the superRefine below and ONLY for kept rows. This is what
    // lets a teacher remove (unkeep) a blank row she added — an unselected row
    // is archived (if it exists) or skipped (if new), so its contents are
    // irrelevant and must never block the submit. Field-level messages are
    // stable tokens the callers localize (see saveTemplatesAction).
    name: z.string().max(80).default(""),
    // Optional topic label (e.g. "Conversation"). Empty string → null so a
    // blank input doesn't persist as "". Never required — single-subject
    // teachers leave it blank.
    subject: z
      .union([z.literal("").transform(() => null), z.string().max(60)])
      .nullable()
      .default(null),
    classCount: z.coerce.number().int().default(1),
    // An individual class sold one-at-a-time (student pays when reserving the
    // slot). class_count is always 1 for these — the transform below pins it so
    // a tampered or stale form value can't sell "5 single classes".
    singleClass: z.coerce.boolean().default(false),
    classDurationMin: z.coerce.number().int().default(50),
    priceMinorUnits: z.coerce.number().int().default(0),
    transferPriceMinorUnits: z
      .union([z.literal("").transform(() => undefined), z.coerce.number().int().nonnegative()])
      .optional(),
    // null = teacher left validity blank. Nullable so an unkept row can carry
    // it; a kept row is required to fill it in (enforced in the superRefine).
    expirationMonths: z.coerce.number().int().nullable().default(null),
    keep: z.coerce.boolean().default(true),
  })
  .transform((t) => (t.singleClass ? { ...t, classCount: 1 } : t))
  .superRefine((t, ctx) => {
    // Unselected/removed rows carry no package to validate.
    if (!t.keep) return;
    if (t.name.trim().length < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "name_required" });
    }
    if (!Number.isInteger(t.classCount) || t.classCount < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classCount"],
        message: "class_count_positive",
      });
    }
    if (!Number.isInteger(t.classDurationMin) || t.classDurationMin < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["classDurationMin"],
        message: "duration_positive",
      });
    }
    if (t.priceMinorUnits < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["priceMinorUnits"],
        message: "price_nonnegative",
      });
    }
    if (t.expirationMonths === null || t.expirationMonths < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expirationMonths"],
        message: "expiration_positive",
      });
    }
  });

// Templates schema doesn't have locale-specific messages — the per-field
// validators here use Zod defaults, and the form-level errors come from
// the action. Keeping as a plain constant.
export const templatesSchema = z.object({
  templates: z.array(packageTemplateSchema),
});
export type TemplatesInput = z.infer<typeof templatesSchema>;

// No locale-specific messages — the only validation here is UUID + datetime
// format, which Zod handles with default messages the action wraps.
export const bookingRequestSchema = z.object({
  packageId: z.string().uuid(),
  startUtc: z.string().datetime(),
});
export type BookingRequestInput = z.infer<typeof bookingRequestSchema>;

// Strip spaces and common separators so a pasted, formatted number like
// "+1 555 123 4567" or "(55) 1234-5678" passes the digits-only E.164 check
// below. International numbers are fully supported — the student just needs
// to include their country code. Empty input resolves to undefined.
const optionalPhoneInput = (loc: Loc) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.replace(/[\s().-]/gu, "") : v),
    z
      .string()
      .trim()
      .regex(/^\+?\d{8,15}$/u, loc("Número de teléfono inválido", "Invalid phone number"))
      .optional()
      .or(z.literal("").transform(() => undefined)),
  );

// `paymentMethod` defaults to "stripe" so existing callers keep working.
export const checkoutIntentSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    slug: z.string().min(1),
    templateId: z.string().uuid(),
    // The student picks a slot before paying; its UTC start rides through
    // checkout and the auto-book-on-paid job turns it into a booking once
    // payment lands. Since D-111 that applies to any offering — required for a
    // single class (the slot IS the reservation), optional "pick your first
    // class" for a package — so absent means "not picked", not "package buy".
    // A missing field arrives as null (FormData.get) or "" (the hidden input),
    // both of which collapse to undefined.
    intendedStartUtc: z.preprocess(
      (v) => (v == null || v === "" ? undefined : v),
      z.string().datetime().optional(),
    ),
    studentName: z.string().min(1, loc("Tu nombre es requerido", "Your name is required")).max(80),
    studentEmail: emailField(loc),
    studentPhone: optionalPhoneInput(loc),
    paymentMethod: z.enum(["stripe", "manual_transfer"]).default("stripe"),
    // Which payout instrument the student picked, for `manual_transfer`
    // (D-113). Absent for Stripe. The server re-checks ownership and
    // offerability — this only bounds the shape.
    //
    // Absent arrives as null (FormData.get) or "" (the always-present hidden
    // input); both mean "no instrument". `emptyToUndef` handles only the
    // empty string, so null would reach z.string() and fail every Stripe
    // checkout submitted from a form without the field.
    instrumentId: z.preprocess(nullishToUndef, z.string().uuid().optional()),
    // PostHog browser session id forwarded by checkout-form.tsx so we
    // can attach `$session_id` when payment_received fires later.
    // Empty string when posthog-js isn't initialized (ad-blocker, no
    // creds in dev). Loose validation — we don't need to reject a
    // checkout because a session id looks malformed.
    posthogSessionId: z
      .string()
      .max(200)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    // Optional discount/referral code (Phase 2). Loose here — the real check
    // (exists/active/limits/referral) runs server-side in the checkout core.
    // Preprocess so an absent field (null) or empty string both become
    // undefined rather than failing the parse.
    discountCode: z.preprocess(
      (v) => (v === null || v === "" ? undefined : v),
      z.string().trim().max(40).optional(),
    ),
  });
};
export type CheckoutIntentInput = z.infer<ReturnType<typeof checkoutIntentSchema>>;

// Booking-page lead capture (docs/features/student-acquisition.md, D-24):
// a visitor who isn't ready to buy leaves their contact details and an optional
// message so the teacher can follow up. The number here is a contact detail
// the teacher uses to reply manually, not
// a subscription to automated platform messaging.
export const leadCaptureSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    slug: z.string().min(1),
    name: z.string().trim().min(1, loc("Tu nombre es requerido", "Your name is required")).max(80),
    email: emailField(loc),
    phone: optionalPhoneInput(loc),
    // ISO-3166-1 alpha-2, picked next to the phone field — resolves a bare
    // national-format `phone` to the right country's calling code. Absent
    // (older client) falls back to normalizeE164's MX default.
    phoneCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
    // Empty / whitespace-only collapses to undefined so the action writes a
    // null message rather than an empty string.
    message: z
      .string()
      .trim()
      .max(1000, loc("Máximo 1000 caracteres.", "Keep it under 1000 characters."))
      .optional()
      .transform((v) => (v ? v : undefined)),
    posthogSessionId: z
      .string()
      .max(200)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  });
};
export type LeadCaptureInput = z.infer<ReturnType<typeof leadCaptureSchema>>;

// Student self-service contact edit on /mis-clases/cuenta and the mobile
// equivalent. Email is deliberately absent — changing the sign-in email
// needs the verified email-change flow, not a plain form field.
export const studentContactSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    name: z.string().trim().min(1, loc("Tu nombre es requerido", "Your name is required")).max(80),
    phone: optionalPhoneInput(loc),
    // ISO-3166-1 alpha-2, picked next to the phone field on the student's own
    // account page — a Student has no first-class country of its own, so this
    // is the only source of truth for resolving a bare national-format phone.
    phoneCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
    timezone: z
      .string()
      .max(64)
      .refine(isValidTimezone, { message: loc("Zona horaria inválida", "Invalid time zone") })
      .optional()
      .or(z.literal("").transform(() => undefined)),
  });
};
export type StudentContactInput = z.infer<ReturnType<typeof studentContactSchema>>;

// Teacher self-service contact edit on the teacher account page (web + mobile).
// The teacher number is the platform → teacher contact line. Email is absent
// for the same reason as students — it's the sign-in identity and
// changes through the verified email-change flow, never a plain field.
export const teacherContactSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    name: z.string().trim().min(1, loc("Tu nombre es requerido", "Your name is required")).max(80),
    phone: optionalPhoneInput(loc),
    timezone: z
      .string()
      .max(64)
      .refine(isValidTimezone, { message: loc("Zona horaria inválida", "Invalid time zone") })
      .optional()
      .or(z.literal("").transform(() => undefined)),
    // ISO-3166-1 alpha-2, picked next to the phone field — independent of the
    // teacher's payout country (settings/account/country-form.tsx / Stripe
    // Connect). A teacher's phone can carry a different country's calling
    // code than where she's based for payouts, so this must never be locked
    // to that value. Falls back to the teacher's stored country when omitted.
    phoneCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
  });
};
export type TeacherContactInput = z.infer<ReturnType<typeof teacherContactSchema>>;

// Teacher opt-in edit of the PUBLIC-facing WhatsApp number shown on the
// booking page (/b/<slug>), settings/booking-page (web) and BookingPageCard
// (mobile). Deliberately its own schema, not a reuse of teacherContactSchema
// above — that one edits the private account `phone` field, this one edits
// `publicWhatsappE164`, a separate opt-in with a separate consent scope (see
// the schema.prisma comment on Teacher.publicWhatsappE164).
export const teacherPublicWhatsappSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    whatsapp: optionalPhoneInput(loc),
    // Same independent-of-payout-country rationale as teacherContactSchema's
    // phoneCountry above.
    whatsappCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
  });
};
export type TeacherPublicWhatsappInput = z.infer<ReturnType<typeof teacherPublicWhatsappSchema>>;

// AI material style — teacher-configurable tone/register for AI-generated
// materials (web + mobile). All fields optional; an unset field means "no
// directive", i.e. today's default behavior. The register presets are the
// headline fix for "the AI writes too academically"; `customInstructions` is
// the free-text escape hatch appended to every material's prompt — the
// server wording keeps it subordinate to the language-axis and student-name
// safeguards, so it can tune style but never break the subject logic (D-72).
export const MATERIAL_TONES = ["casual", "friendly", "neutral", "academic"] as const;
export type MaterialTone = (typeof MATERIAL_TONES)[number];
export const MATERIAL_LEARNER_AGES = ["kids", "teens", "adults"] as const;
export type MaterialLearnerAge = (typeof MATERIAL_LEARNER_AGES)[number];

// Vocabulary difficulty (D-80) — a SEPARATE axis from the CEFR language level.
// The CEFR level controls grammar complexity, sentence structures, discourse,
// and abstractness of ideas; this controls how common/rare the WORDS are
// (word frequency, idioms, uncommon synonyms, technical/literary terms). The
// two used to be conflated — a "C1" material was told to pitch "difficulty and
// vocabulary" to C1, which is how a high level produced words the teacher
// didn't recognize. Decoupling them lets, e.g., C1 grammar with Basic words.
//
//   basic    — most common words only; avoid uncommon synonyms; best for
//              teaching new grammar/concepts without a lexical burden.
//   everyday — normal conversational vocabulary (the effective default).
//   advanced — higher-level vocabulary and more complex expressions.
//   native   — rare words, idioms, literary/academic/regional expressions.
//
// A teacher default lives on `teachers.material_vocabulary`; a per-class
// override lives on `bookings.vocabulary_override`. Null at both levels means
// "use the effective default" (everyday) — CEFR level never raises it on its
// own. The "Allow uncommon words" framing maps onto this: off = basic/everyday,
// on = advanced/native. Student-level personalization is intentionally NOT
// modeled yet; the resolver signature leaves room to add it later.
export const MATERIAL_VOCABULARIES = ["basic", "everyday", "advanced", "native"] as const;
export type MaterialVocabulary = (typeof MATERIAL_VOCABULARIES)[number];
// The effective vocabulary when neither the class override nor the teacher
// default is set. Deliberately conservative (common vocabulary) so a high CEFR
// level does not silently pull in rare words — the D-80 product goal.
export const DEFAULT_MATERIAL_VOCABULARY: MaterialVocabulary = "everyday";

// Resolve the vocabulary difficulty that actually drives generation, applying
// the class-override-beats-teacher-default-beats-global-default precedence.
// Pure + dependency-free so both the server generation paths and unit tests
// share one source of truth. (A future `studentOverride` slots in ahead of
// `classOverride` without changing any caller that passes the two it has.)
export function resolveVocabulary(
  classOverride: MaterialVocabulary | null | undefined,
  teacherDefault: MaterialVocabulary | null | undefined,
): MaterialVocabulary {
  return classOverride ?? teacherDefault ?? DEFAULT_MATERIAL_VOCABULARY;
}

// Lesson format — the participant configuration AI-generated material is
// written for (D-88). The platform supports ONE shape today: a `Booking` has
// exactly one `studentId` — there is no multi-student booking anywhere in the
// schema — so `one_to_one` is the only value and every material-generation
// prompt asserts it unconditionally (see `lessonFormatDirective` in
// `apps/web/src/lib/materials/prompt.ts`). It is modeled as a typed enum,
// not a string baked into the prompt, so that IF group classes ship later,
// the extension is additive: add a `"group"` value here, a matching branch in
// `lessonFormatDirective()`, and a `Teacher`/`Booking` field to resolve it
// from (the same teacher-default/per-class-override precedent as
// `MaterialVocabulary` above) — no call site changes, no new plumbing.
export const LESSON_FORMATS = ["one_to_one"] as const;
export type LessonFormat = (typeof LESSON_FORMATS)[number];
// The only value today; every prompt builder defaults to this when unset.
export const DEFAULT_LESSON_FORMAT: LessonFormat = "one_to_one";

export const MATERIAL_LANGUAGE_VARIETY_MAX = 60;
export const MATERIAL_CUSTOM_INSTRUCTIONS_MAX = 600;

// Coerce a form/JSON value to null when empty so "unset" is uniform across
// web FormData (which posts "") and the mobile JSON body (which may send null).
const blankToNull = (v: unknown) => {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  return v;
};

export const materialStyleSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    tone: z.preprocess(blankToNull, z.enum(MATERIAL_TONES).nullable()).default(null),
    learnerAge: z.preprocess(blankToNull, z.enum(MATERIAL_LEARNER_AGES).nullable()).default(null),
    // Teacher default vocabulary difficulty (D-80). Nullable → the effective
    // default (everyday). Written by the mobile material-style route AND, since
    // the settings-page redesign, by the web save action — the web form posts
    // the stored value back unchanged unless the teacher moves the dial.
    vocabulary: z.preprocess(blankToNull, z.enum(MATERIAL_VOCABULARIES).nullable()).default(null),
    languageVariety: z
      .preprocess(
        blankToNull,
        z
          .string()
          .max(
            MATERIAL_LANGUAGE_VARIETY_MAX,
            loc(
              `Máximo ${MATERIAL_LANGUAGE_VARIETY_MAX} caracteres`,
              `Maximum ${MATERIAL_LANGUAGE_VARIETY_MAX} characters`,
            ),
          )
          .nullable(),
      )
      .default(null),
    customInstructions: z
      .preprocess(
        blankToNull,
        z
          .string()
          .max(
            MATERIAL_CUSTOM_INSTRUCTIONS_MAX,
            loc(
              `Máximo ${MATERIAL_CUSTOM_INSTRUCTIONS_MAX} caracteres`,
              `Maximum ${MATERIAL_CUSTOM_INSTRUCTIONS_MAX} characters`,
            ),
          )
          .nullable(),
      )
      .default(null),
  });
};
export type MaterialStyleInput = z.infer<ReturnType<typeof materialStyleSchema>>;

// Teacher roster fix for a student's contact card (checkout typos, "my
// email is wrong so I get nothing"). Email is only applied while the
// student has never signed in — the service enforces that against
// authUserId; the form disables the field for linked students. An empty
// email means "leave as is", never "clear".
export const teacherEditStudentContactSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    studentId: z.string().uuid(),
    name: z.string().trim().min(1, loc("El nombre es requerido", "The name is required")).max(80),
    email: z
      .string()
      .trim()
      .email(loc("Correo inválido", "Invalid email"))
      .max(254)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    phone: optionalPhoneInput(loc),
    // ISO-3166-1 alpha-2, picked next to the phone field. Defaults to the
    // teacher's own country in the UI (same-market guess), always overridable.
    phoneCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
  });
};
export type TeacherEditStudentContactInput = z.infer<
  ReturnType<typeof teacherEditStudentContactSchema>
>;

// Teacher staging a student by hand (silent onboarding — replacing the
// paper roster before going live). Mirrors the contact-edit fields but
// without a studentId (we're creating the row). Email is optional: a
// provisioned student can exist with no email until the teacher has it,
// matching the funnel's find-or-create.
export const teacherCreateStudentSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    name: z.string().trim().min(1, loc("El nombre es requerido", "The name is required")).max(80),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email(loc("Correo inválido", "Invalid email"))
      .max(254)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    phone: optionalPhoneInput(loc),
    // ISO-3166-1 alpha-2, picked next to the phone field. Defaults to the
    // teacher's own country in the UI (same-market guess), always overridable.
    phoneCountry: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
  });
};
export type TeacherCreateStudentInput = z.infer<ReturnType<typeof teacherCreateStudentSchema>>;

// In-portal repurchase (/mis-clases/comprar). No buyer fields — identity
// comes from the session — so there's nothing locale-dependent to report;
// a mismatch here means a tampered form, not a typo.
export const portalCheckoutIntentSchema = z.object({
  teacherId: z.string().uuid(),
  templateId: z.string().uuid(),
  // See checkoutIntentSchema.intendedStartUtc — same pay-at-reservation slot
  // for the in-portal repurchase path.
  intendedStartUtc: z.preprocess(
    (v) => (v == null || v === "" ? undefined : v),
    z.string().datetime().optional(),
  ),
  paymentMethod: z.enum(["stripe", "manual_transfer"]).default("stripe"),
  // See checkoutIntentSchema.instrumentId.
  instrumentId: z.preprocess(nullishToUndef, z.string().uuid().optional()),
  posthogSessionId: z
    .string()
    .max(200)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  discountCode: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().trim().max(40).optional(),
  ),
});
export type PortalCheckoutIntentInput = z.infer<typeof portalCheckoutIntentSchema>;

// Settings form for /settings/payments — Wise card. The DB CHECK
// constraints mirror these for defense-in-depth.

// --- Payout instruments (D-113) --------------------------------------------
//
// One schema per instrument kind rather than one schema with a `kind`
// discriminator and every field optional: each kind's required field is
// genuinely required, and a shared schema can only express that as a chain of
// refines that drift. These mirror the per-kind CHECK constraints on
// `teacher_payout_instruments`.

const accountHolderField = (loc: Loc) =>
  z.preprocess(
    emptyToUndef,
    z.string().trim().max(120, loc("Nombre demasiado largo", "Name too long")).optional(),
  );

export const wiseInstrumentSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z
    .object({
      enabled: z.coerce.boolean().default(false),
      handle: z.preprocess(
        emptyToUndef,
        z
          .string()
          .trim()
          .regex(
            WISE_HANDLE_RE,
            loc("Wisetag inválido (2-32 caracteres)", "Invalid Wisetag (2-32 characters)"),
          )
          .optional(),
      ),
      accountHolder: accountHolderField(loc),
      email: z.preprocess(
        emptyToUndef,
        z.string().trim().email(loc("Correo inválido", "Invalid email")).optional(),
      ),
    })
    .refine((v) => !v.enabled || Boolean(v.handle), {
      message: loc("Necesitas un Wisetag para activar Wise.", "You need a Wisetag to enable Wise."),
      path: ["handle"],
    });
};
export type WiseInstrumentInput = z.infer<ReturnType<typeof wiseInstrumentSchema>>;

// Which instrument a student picked at checkout. `stripe` carries no
// instrument; `manual_transfer` must name one, because "which payee
// instructions was this student shown" is not recoverable after the fact.
export const paymentSelectionSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z
    .object({
      paymentMethod: z.enum(["stripe", "manual_transfer"]),
      instrumentId: z.preprocess(nullishToUndef, z.string().uuid().optional()),
    })
    .refine((v) => v.paymentMethod !== "manual_transfer" || Boolean(v.instrumentId), {
      message: loc("Elige un método de transferencia.", "Choose a transfer method."),
      path: ["instrumentId"],
    })
    .refine((v) => v.paymentMethod !== "stripe" || !v.instrumentId, {
      message: loc("Selección de pago inválida.", "Invalid payment selection."),
      path: ["instrumentId"],
    });
};
export type PaymentSelectionInput = z.infer<ReturnType<typeof paymentSelectionSchema>>;

// Teacher confirms a manual-transfer payment was received. Reason is recorded
// as the override `reason` and surfaces in audit.
export const transferConfirmSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    paymentId: z.string().uuid(),
    note: z
      .string()
      .trim()
      .max(200, loc("Nota demasiado larga", "Note too long"))
      .optional()
      .or(z.literal("").transform(() => undefined)),
  });
};

// --- Teacher → Student invitations (D-83) ----------------------------------

// A single invitee (form or one parsed row). Email required (that's the
// acceptance target); name optional (falls back to the email/roster name).
export const singleInviteSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z.object({
    email: emailField(loc).max(254),
    name: z
      .string()
      .trim()
      .max(80, loc("Nombre demasiado largo", "Name too long"))
      .optional()
      .or(z.literal("").transform(() => undefined)),
  });
};
export type SingleInviteInput = z.infer<ReturnType<typeof singleInviteSchema>>;

// Bulk invite: either a pasted/CSV blob (`list`) OR a set of already-rostered
// student ids to invite (`studentIds`), or both. The server parses `list` with
// lib/invitations/bulk.ts and validates each row there, so this schema only
// bounds sizes.
export const bulkInviteSchema = (locale: AppLocale = "en") => {
  const loc = t(locale);
  return z
    .object({
      list: z
        .string()
        .max(50_000, loc("La lista es demasiado larga", "The list is too long"))
        .optional()
        .or(z.literal("").transform(() => undefined)),
      studentIds: z.array(z.string().uuid()).max(500).optional(),
    })
    .refine(
      (v) => (v.list && v.list.trim().length > 0) || (v.studentIds && v.studentIds.length > 0),
      {
        message: loc("Agrega al menos un alumno.", "Add at least one student."),
        path: ["list"],
      },
    );
};
export type BulkInviteInput = z.infer<ReturnType<typeof bulkInviteSchema>>;

// Resend / cancel / copy-link operate on one invitation id.
export const invitationActionSchema = z.object({
  invitationId: z.string().uuid(),
});
export type InvitationActionInput = z.infer<typeof invitationActionSchema>;
