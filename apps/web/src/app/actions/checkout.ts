"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale } from "@/lib/i18n";
import { getAuthUser } from "@/lib/auth";
import { checkoutIntentSchema, portalCheckoutIntentSchema } from "@/lib/validators";
import { normalizeE164 } from "@/lib/phone";
import { purchasingLinkFor, studentIdentityIds } from "@/lib/students/identity";
import {
  findOrCreateRosterStudent,
  TeacherEmailConflictError,
} from "@/lib/students/find-or-create";
import { railReadinessError, startCheckout } from "@/lib/payments/start-checkout";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { INSTRUMENT_READINESS_SELECT, isPubliclyListed } from "@/lib/marketplace-ready";
import { hasStripeEmbeddedCheckout } from "@/lib/env";
import { usesEnglishCopy } from "@spiralclass/shared";

// Wise stays a redirect (thrown by next/navigation's redirect() — never
// reaches this return type). A Stripe checkout renders inline via
// @stripe/react-stripe-js's Embedded Checkout, so on success the action
// returns the Checkout Session's client_secret instead of redirecting.
// What the buyer typed, echoed back on failure.
//
// React 19 RESETS an uncontrolled form once its action resolves, so every
// error return used to wipe the name and email the buyer had just entered.
// That was invisible while a Stripe failure threw to the error boundary (the
// whole page went, fields included); with the failure rendering inline it is
// the difference between "try again" and "type it all again".
//
// A reset restores each input to its CURRENT `defaultValue`, so handing these
// back through the action state and rendering them as the defaults makes the
// reset land on what they typed instead of on empty.
export type CheckoutFormValues = { studentName: string; studentEmail: string };

export type CheckoutState =
  | { error?: string; values?: CheckoutFormValues }
  | { clientSecret: string; externalReference: string }
  | undefined;

// Shared field set the checkout core needs from a Teacher row.
const CHECKOUT_TEACHER_SELECT = {
  id: true,
  name: true,
  bookingSlug: true,
  // The phone-normalization hint for a student number captured here — see the
  // normalizeE164 call below.
  country: true,
  onboardingCompleteAt: true,
  disabledAt: true,
  stripeAccountId: true,
  stripeChargesEnabled: true,
  pricingCurrency: true,
  payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
  photoPath: true,
  bio: true,
  templatesTouchedAt: true,
  availabilityTouchedAt: true,
} as const;

// Student-facing: creates a purchase intent and redirects to either
//   * Stripe Checkout (the existing card path), or
//   * /b/[slug]/buy/wise/[ref] (the Wise instructions page).
//
// Runs on a public route (no authenticated user). This action owns the
// public-funnel specifics — form parsing and the Student upsert — and then
// hands off to the shared core (src/lib/payments/start-checkout.ts):
//   1. Resolves the teacher by booking slug + asserts the chosen rail is
//      ready to charge (Stripe Connect verified, or Wise handle on file).
//   2. Upserts Student + TeacherStudent so the student exists before
//      payment (so magic-link sign-in after payment works).
//   3. startCheckout creates Package(pending) + Payment(pending) and
//      returns the redirect target for the chosen rail.
//
// Only fixed-kind templates are accepted — package templates (post-restructure)
// removed monthly subscriptions from the user-facing surface.
// Never trusts the template price from the client — always reads from
// the database row so a tampered hidden field can't alter the charge.
// Thin wrapper over the real action: every `{ error }` it returns carries the
// submitted name and email back with it, so the post-action reset restores
// them. Wrapping once beats threading `values` through fourteen separate error
// returns and forgetting it on the fifteenth.
//
// Deliberately only on the failure path — a success either redirects or hands
// back a client_secret, and neither renders this form again.
export async function createCheckoutIntent(
  prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const result = await createCheckoutIntentCore(prev, formData);
  if (result && "error" in result && result.error) {
    return {
      ...result,
      values: {
        studentName: String(formData.get("studentName") ?? ""),
        studentEmail: String(formData.get("studentEmail") ?? ""),
      },
    };
  }
  return result;
}

async function createCheckoutIntentCore(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = checkoutIntentSchema(locale).safeParse({
    slug: formData.get("slug"),
    templateId: formData.get("templateId"),
    intendedStartUtc: formData.get("intendedStartUtc"),
    studentName: formData.get("studentName"),
    studentEmail: formData.get("studentEmail"),
    // The public checkout no longer collects a phone (removed to shorten the
    // form). An absent field is `null` from FormData; the schema's optional
    // phone accepts `undefined`/`""` but not `null`, so coerce here.
    studentPhone: formData.get("studentPhone") ?? undefined,
    paymentMethod: formData.get("paymentMethod"),
    instrumentId: formData.get("instrumentId"),
    posthogSessionId: formData.get("posthogSessionId"),
    discountCode: formData.get("discountCode"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }
  const input = parsed.data;

  const teacher = await prisma.teacher.findUnique({
    where: { bookingSlug: input.slug },
    select: CHECKOUT_TEACHER_SELECT,
  });
  // Public/anonymous funnel: same visibility rule as the booking landing.
  // The signed-in
  // portal repurchase below (createPortalCheckoutIntent) deliberately keeps
  // the looser onboardingCompleteAt-only check — an existing student
  // relationship shouldn't break because the teacher's public profile isn't
  // "complete" by marketplace standards.
  if (!teacher || !isPubliclyListed(teacher)) {
    return { error: en ? "That teacher isn't available." : "Esa maestra no está disponible." };
  }

  const railError = railReadinessError(
    teacher,
    input.paymentMethod,
    locale,
    teacher.payoutInstruments,
  );
  if (railError) return { error: railError };

  const template = await prisma.packageTemplate.findFirst({
    where: { id: input.templateId, teacherId: teacher.id, archived: false },
  });
  if (!template) {
    return { error: en ? "The package doesn't exist." : "El paquete no existe." };
  }

  // A disabled student should be blocked platform-wide, whatever teacher's
  // link they pay through; otherwise the moderation action is trivially
  // bypassed by paying via a second teacher. This also covers the student's
  // own roster row with this teacher.
  const platformDisabled = await prisma.student.findFirst({
    where: {
      email: { equals: input.studentEmail, mode: "insensitive" },
      disabledAt: { not: null },
    },
    select: { id: true },
  });
  if (platformDisabled) {
    return {
      error: en
        ? "This account is disabled. Email support if you think that's a mistake."
        : "Esta cuenta está deshabilitada. Escríbenos a soporte si crees que es un error.",
    };
  }

  // The public web checkout form deliberately dropped the phone field (see
  // checkout-form.tsx) to shorten it, so `studentPhone` is not populated
  // through this surface today. The teacher's own country is passed as the
  // hint anyway — parity with the mobile public-checkout route, and a far
  // better guess than the module's last-resort default for a teacher who is
  // not in Mexico. If a phone field returns here, wire a country picker
  // alongside it (leads.ts does) so the student declares her own instead.
  const phoneE164 = input.studentPhone ? normalizeE164(input.studentPhone, teacher.country) : null;

  // Advisory-locked find-or-create: one Student row per (teacher, email),
  // even when the form is double-submitted. See lib/students/find-or-create.
  // Teacher overrides grandfathered pricing + the double-charge guard live in
  // startCheckout, so the action only has to resolve the student.
  let student;
  try {
    student = await findOrCreateRosterStudent({
      teacherId: teacher.id,
      email: input.studentEmail,
      name: input.studentName,
      phoneE164,
    });
  } catch (err) {
    if (err instanceof TeacherEmailConflictError) {
      return {
        error: en
          ? "This email belongs to a teacher account and can't be used to buy classes."
          : "Este correo pertenece a una cuenta de maestra y no puede usarse para comprar clases.",
      };
    }
    throw err;
  }

  const result = await startCheckout({
    teacher,
    student: { id: student.id, email: student.email, name: student.name },
    template,
    paymentMethod: input.paymentMethod,
    instrumentId: input.instrumentId,
    posthogSessionId: input.posthogSessionId,
    discountCode: input.discountCode,
    source: "public",
    intendedStartUtc: input.intendedStartUtc ? new Date(input.intendedStartUtc) : undefined,
    locale,
    // Card payments render inline (Embedded Checkout); a manual transfer
    // stays a redirect to the instructions page regardless of this flag.
    stripeUiMode: hasStripeEmbeddedCheckout() ? "embedded" : "hosted",
  });
  if ("error" in result) return { error: result.error };
  // Drain checkout_started/discount_applied/referral_attributed before the
  // redirect/return — this action is the only caller of startCheckout() that
  // never flushed, unlike the Stripe/Wise webhook paths further down the funnel.
  await flushAnalytics();
  if (result.mode === "embedded") {
    return { clientSecret: result.clientSecret, externalReference: result.externalReference };
  }
  if (result.mode !== "redirect") {
    return { error: en ? "Unexpected checkout response." : "Respuesta de pago inesperada." };
  }
  redirect(result.redirectTo);
}

// Signed-in repurchase from the student portal (/my-classes/buy).
// Identity comes from the session — never from a typed email — so a repeat
// purchase can't fork the student's history into a second account when
// they spell their address differently the second time around. Same core
// as the public funnel: grandfathered pricing, the pending-checkout
// supersession guard, and the Stripe/Wise split all apply unchanged.
export async function createPortalCheckoutIntent(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = portalCheckoutIntentSchema.safeParse({
    teacherId: formData.get("teacherId"),
    templateId: formData.get("templateId"),
    intendedStartUtc: formData.get("intendedStartUtc"),
    paymentMethod: formData.get("paymentMethod"),
    instrumentId: formData.get("instrumentId"),
    posthogSessionId: formData.get("posthogSessionId"),
    discountCode: formData.get("discountCode"),
  });
  if (!parsed.success) {
    return { error: en ? "Invalid data" : "Datos inválidos" };
  }
  const input = parsed.data;

  const user = await getAuthUser();
  if (!user) redirect("/sign-in");
  const student = await prisma.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true, email: true, name: true, disabledAt: true },
  });
  if (!student) {
    return { error: en ? "Account not found." : "Cuenta no encontrada." };
  }
  if (student.disabledAt) {
    return {
      error: en
        ? "This account is disabled. Email support if you think that's a mistake."
        : "Esta cuenta está deshabilitada. Escríbenos a soporte si crees que es un error.",
    };
  }

  // The portal only sells across an existing, non-archived pairing. An
  // archived ("dar de baja") student keeps the public /b/[slug] link as
  // the escape hatch — the teacher parked the relationship, so the portal
  // doesn't offer her packages back proactively.
  //
  // The pairing may live on a sibling row of this identity (same inbox,
  // another teacher's roster — see studentIdentityIds). The purchase must
  // land on THAT row so the package, grandfathered price, and the
  // teacher's roster view all stay attached to her student.
  //
  // purchasingLinkFor is the shared resolver the buy page prices against, so
  // the row shown a price and the row charged for it cannot diverge. It also
  // skips archived pairings rather than only rejecting the oldest one: this
  // used to take the oldest link of ANY state and refuse the sale if it
  // happened to be archived, which blocked a student with a live pairing
  // whose first, parked pairing was older — a teacher the portal was
  // simultaneously offering.
  const link = await purchasingLinkFor(input.teacherId, await studentIdentityIds(student));
  if (!link) {
    return { error: en ? "That teacher isn't available." : "Esa maestra no está disponible." };
  }
  const buyer =
    link.studentId === student.id
      ? student
      : await prisma.student.findUnique({
          where: { id: link.studentId },
          select: { id: true, email: true, name: true, disabledAt: true },
        });
  if (!buyer || buyer.disabledAt) {
    return { error: en ? "Account not found." : "Cuenta no encontrada." };
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: input.teacherId },
    select: CHECKOUT_TEACHER_SELECT,
  });
  if (!teacher || !teacher.onboardingCompleteAt || teacher.disabledAt) {
    return { error: en ? "That teacher isn't available." : "Esa maestra no está disponible." };
  }

  const railError = railReadinessError(
    teacher,
    input.paymentMethod,
    locale,
    teacher.payoutInstruments,
  );
  if (railError) return { error: railError };

  const template = await prisma.packageTemplate.findFirst({
    where: { id: input.templateId, teacherId: teacher.id, archived: false },
  });
  if (!template) {
    return { error: en ? "The package doesn't exist." : "El paquete no existe." };
  }

  const result = await startCheckout({
    teacher,
    student: { id: buyer.id, email: buyer.email, name: buyer.name },
    template,
    paymentMethod: input.paymentMethod,
    instrumentId: input.instrumentId,
    posthogSessionId: input.posthogSessionId,
    discountCode: input.discountCode,
    source: "portal",
    intendedStartUtc: input.intendedStartUtc ? new Date(input.intendedStartUtc) : undefined,
    locale,
    stripeUiMode: hasStripeEmbeddedCheckout() ? "embedded" : "hosted",
  });
  if ("error" in result) return { error: result.error };
  await flushAnalytics();
  if (result.mode === "embedded") {
    return { clientSecret: result.clientSecret, externalReference: result.externalReference };
  }
  if (result.mode !== "redirect") {
    return { error: en ? "Unexpected checkout response." : "Respuesta de pago inesperada." };
  }
  redirect(result.redirectTo);
}
