import {
  currencyForTeacher,
  currencyExponent,
  hasOfferableInstrument,
  stripeMinChargeMinorUnits,
  type InstrumentReadiness,
  usesEnglishCopy,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import type { AppLocale } from "@/lib/i18n";
import { getStripeClient } from "@/lib/stripe";
import { stripeTaxEnabled } from "@/lib/stripe/tax";
import { generatePaymentReference } from "@/lib/payments/reference";
import { railForKind, resolveOfferableInstrument } from "@/lib/payments/instruments";
import { INSTRUMENT_READINESS_SELECT } from "@/lib/marketplace-ready";
import { enqueuePaymentPendingTeacher } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { supersedePendingCheckouts } from "@/lib/payments/supersede-pending";
import { discountRejectMessage, resolveAndValidateDiscount } from "@/lib/discounts";
import {
  effectivePriceMinorUnits,
  grandfatheredPricesFor,
} from "@/lib/payments/grandfathered-prices";
import { referralRejectMessage, resolveReferralForCheckout } from "@/lib/referrals";
import { aliasServerUser, trackServerEvent } from "@/lib/analytics/posthog";
import { attributionProperties, currentAttribution } from "@/lib/analytics/attribution";
import { recordBookingStarted } from "@/lib/marketing/events";
import { currentPostHogIdentity } from "@/lib/analytics/posthog-cookie";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const log = logger({ surface: "checkout" });

// What a buyer is told when Stripe refuses to create the checkout.
//
// Deliberately not the API's own message. `account_invalid`, an expired key or
// a Stripe outage all mean the same thing to the person holding a card — try
// again, and if it keeps happening it is not your fault — and the raw text
// ("The provided key 'sk_test_…' does not have access to account 'acct_…'")
// leaks the shape of our Stripe setup to a stranger.
function stripeUnavailableMessage(en: boolean): string {
  return en
    ? "We couldn't reach the card provider just now. Try again, or pay by bank transfer instead."
    : "No pudimos conectar con el proveedor de pagos. Inténtalo de nuevo o paga por transferencia.";
}

// Shared checkout core behind both purchase entry points:
//   * the public funnel at /b/[slug]/buy (anonymous form → student upsert
//     happens in the action, see src/app/actions/checkout.ts), and
//   * the in-portal repurchase at /my-classes/buy (student identity comes
//     from the session — no form, no email re-entry, no duplicate-account
//     risk from a retyped address).
//
// Callers resolve teacher + student + template (each entry point has its own
// rules for that); everything from pricing to the redirect target is one code
// path so grandfathering, the double-charge guard, reference generation and
// webhook idempotency can't drift between the two flows.

export type CheckoutTeacher = {
  id: string;
  name: string;
  bookingSlug: string;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  // ISO-3166-1 alpha-2, her Stripe account's country. Used only to pick the
  // bank-transfer variant Checkout needs to offer SPEI; null simply means no
  // bank transfer is offered.
  country: string | null;
  // Drives the currency of the Package/Payment rows and the Stripe Checkout
  // Session (via currencyForTeacher). Null → default MXN (shouldn't happen
  // post-migration — every teacher gets a value at onboarding).
  pricingCurrency: string | null;
};

export type CheckoutTemplate = {
  id: string;
  name: string;
  classCount: number;
  classDurationMin: number;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
};

export type StartCheckoutArgs = {
  teacher: CheckoutTeacher;
  student: { id: string; email: string | null; name: string };
  template: CheckoutTemplate;
  paymentMethod: "stripe" | "manual_transfer";
  // Which payee instructions the student picked. Required for
  // `manual_transfer` and ignored for Stripe. Verified against this teacher
  // here — it arrives from an untrusted client, so ownership and offerability
  // are re-checked rather than assumed (D-113).
  instrumentId?: string;
  // Optional discount code typed at checkout (slice 2a). Validated + applied
  // here, after the grandfathered/rail price is resolved, so it always composes
  // last. An invalid code fails the checkout with a localized message.
  discountCode?: string;
  posthogSessionId?: string;
  // Funnel attribution for checkout_started: which surface initiated the
  // purchase. "public" = anonymous booking page, "portal" = signed-in
  // student repurchase.
  source: "public" | "portal";
  // Pay-at-reservation: the UTC slot the student chose. It's stored on the
  // pending Package and turned into a booking by the auto-book-on-paid Inngest
  // job once payment lands. Meaningful for ANY offering since D-111 — the
  // reservation for a single class, the first class for a package — and
  // omitted when nothing was picked. It can only ever consume that package's
  // own credit, so carrying it for a multi-class buy books one of the classes
  // already paid for rather than smuggling an extra one.
  intendedStartUtc?: Date;
  locale: AppLocale;
  // Stripe rail only (ignored for a manual transfer, which is always a
  // redirect to the instructions page). "hosted" (default) redirects to a Stripe-hosted
  // Checkout page — unchanged behavior, what every existing caller gets.
  // "embedded" mints a Checkout Session client_secret instead, for a caller
  // that wants to mount the Payment Element inline (no redirect) via
  // @stripe/react-stripe-js's EmbeddedCheckoutProvider.
  stripeUiMode?: "hosted" | "embedded";
};

// `externalReference` is the Payment row's reference — the key the result page
// (/b/<slug>/buy/result) polls on, regardless of rail or auth state.
// The web funnel embeds it in the Stripe success/cancel URLs so every rail
// lands on the same polling screen.
export type StartCheckoutResult =
  | { mode: "redirect"; redirectTo: string; externalReference: string }
  | { mode: "embedded"; clientSecret: string; externalReference: string }
  | { error: string };

// Rail-readiness gate shared by both actions. Returns a localized error or
// null when the chosen rail can charge. Kept separate from startCheckout so
// the public action can refuse before upserting a Student row.
//
// The manual-transfer branch checks only that the teacher has SOME offerable
// instrument; whether the SPECIFIC instrument the student picked is still
// offerable is re-checked inside startCheckout, where the id is resolved
// against the database. Both checks are needed: this one gives a good error
// before a Student row is created, the other closes the gap between the page
// render and the submit.
export function railReadinessError(
  teacher: Pick<CheckoutTeacher, "stripeAccountId" | "stripeChargesEnabled" | "pricingCurrency">,
  paymentMethod: "stripe" | "manual_transfer",
  locale: AppLocale,
  instruments: readonly InstrumentReadiness[],
): string | null {
  const en = usesEnglishCopy(locale);
  if (paymentMethod === "stripe") {
    if (!teacher.stripeAccountId || !teacher.stripeChargesEnabled) {
      return en
        ? "This teacher doesn't accept card payments yet. Ask them to finish Stripe setup, or choose a bank transfer."
        : "Esta profe todavía no acepta pagos con tarjeta. Pídele que complete la conexión con Stripe o elige una transferencia.";
    }
    return null;
  }
  if (!hasOfferableInstrument(instruments, currencyForTeacher(teacher))) {
    return en
      ? "This teacher isn't accepting bank transfers right now."
      : "Esta profe no está aceptando transferencias en este momento.";
  }
  return null;
}

// Instrument readiness for one teacher, for the below-minimum hint. Lazy on
// purpose: the hint is a rare branch and this would otherwise be a query on
// every single checkout.
async function instrumentsFor(teacherId: string): Promise<InstrumentReadiness[]> {
  return prisma.teacherPayoutInstrument.findMany({
    where: { teacherId },
    // The shared readiness projection, not a hand-written one: this select
    // outlived D-145's removal of `schemeId`/`details` and would have thrown
    // at query time the next time the below-minimum hint path ran.
    select: INSTRUMENT_READINESS_SELECT,
  });
}

// Creates Package(pending) + Payment(pending) and returns where to send the
// student: the Stripe hosted checkout URL, or the transfer instructions page.
// Both flows land on /b/<slug>/buy/result afterwards — that page is
// keyed by the Payment's externalReference, not by auth state, so it serves
// anonymous first-time buyers and signed-in repurchasers alike.
export async function startCheckout(args: StartCheckoutArgs): Promise<StartCheckoutResult> {
  const { teacher, student, template, paymentMethod, locale } = args;
  const en = usesEnglishCopy(locale);
  const env = serverEnv();
  const appUrl = env.APP_URL.replace(/\/$/, "");
  // The settlement currency for this teacher's rows — the teacher's own
  // chosen pricing currency, never hardcoded.
  const currency = currencyForTeacher(teacher);

  // Throttle the checkout-create entry. This is the unauthenticated booking
  // path (the public funnel hands off here before any auth), and every call
  // creates Package + Payment rows and — on the card rail — a Stripe Checkout
  // session, so an unthrottled loop could spray junk rows / hammer Stripe.
  // Mirror the auth-flow pattern (clientIp + rateLimit): a small per-IP budget
  // per minute, plus a per (slug, student) budget so a single buyer behind a
  // shared IP can't be starved by, and can't itself spam, the endpoint. Fails
  // open if the limiter backend is down (see rate-limit.ts).
  const ip = await clientIp();
  const ipRl = await rateLimit(ip, {
    scope: "checkout-create",
    limit: 10,
    windowMs: 60_000,
  });
  const buyerKey = `${teacher.bookingSlug}:${student.id}`;
  const buyerRl = ipRl.ok
    ? await rateLimit(buyerKey, {
        scope: "checkout-create-buyer",
        limit: 6,
        windowMs: 60_000,
      })
    : ipRl;
  if (!ipRl.ok || !buyerRl.ok) {
    return {
      error: en
        ? "Too many checkout attempts. Wait a minute and try again."
        : "Demasiados intentos de pago. Espera un minuto e inténtalo de nuevo.",
    };
  }

  // Stripe Checkout requires customer_email. Funnel students always have
  // one (the form requires it); portal students signed in via magic link
  // do too. A teacher-provisioned student without an email is the only way
  // here — refuse cleanly rather than let Stripe reject the session.
  if (paymentMethod === "stripe" && !student.email) {
    return {
      error: en
        ? "Your account has no email on file. Ask your teacher to add one."
        : "Tu cuenta no tiene correo registrado. Pídele a tu profe que lo agregue.",
    };
  }

  // Grandfathering: an agreed price for THIS package wins over the
  // catalog price, for both rails (no separate grandfathered Wise price —
  // "rare * rare", added only if a real teacher asks). Per package since
  // 2026-09-01: the flat column this replaces applied one number to whichever
  // package the student picked, so a student held at an old 4-class price
  // could buy the 20-class package at it.
  const grandfathered = await grandfatheredPricesFor(prisma, teacher.id, student.id);
  // Base price before any discount.
  const basePriceMinorUnits = effectivePriceMinorUnits(grandfathered, template, paymentMethod);
  // The actual charge; a valid discount code (resolved below, after supersede)
  // reduces it. Reassigned in one place so every downstream use — Package,
  // Payment, the Stripe line item, and the funnel event — stays in sync.
  let priceMinorUnits = basePriceMinorUnits;

  // The chosen slot rides through checkout for ANY offering (D-111). For a
  // single class it IS the reservation and the UI requires it; for a package
  // it's an optional "pick your first class", and the remaining credits are
  // booked from the portal later. Null either way when nothing was picked —
  // auto-book-on-paid then returns `no-intent` and the balance is untouched.
  const intendedStartUtc = args.intendedStartUtc ?? null;

  // Cross-rail double-charge guard (MED-4): supersede any still-pending
  // checkout this student already has for this template — expire the old
  // Stripe session so it can't be paid, mark the old package expired — so
  // only one payable rail is ever live for a single purchase intent. Runs
  // before the new rows are created. Best-effort: a Stripe expire failure
  // (session already settled) leaves that package alone.
  try {
    await supersedePendingCheckouts(
      { teacherId: teacher.id, studentId: student.id, templateId: template.id },
      { prisma, getStripe: getStripeClient },
    );
  } catch (err) {
    // Never block a fresh checkout on the cleanup of stale ones. Benign —
    // a stale Stripe session that's already settled is the usual cause.
    log.warn("supersedePendingCheckouts failed", {
      teacherId: teacher.id,
      studentId: student.id,
      templateId: template.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Apply a discount code if one was typed. Validated AFTER supersede so a
  // student retrying with the same code isn't blocked by their own
  // just-superseded redemption (its package is now expired, so it no longer
  // counts). Composes last in the price stack — on the already-resolved
  // base price. An invalid/expired/exhausted code fails the whole checkout
  // with a localized message rather than silently charging full price.
  // A typed code is first tried as a teacher promo (slice 2a); if there's no
  // such code, it's tried as a per-student referral code (slice 2b), which
  // applies the teacher's referred-side discount and is recorded as a Referral.
  let applied:
    | { type: "promo"; codeId: string; amountMinorUnits: number }
    | { type: "referral"; referralCodeId: string; ownerStudentId: string; amountMinorUnits: number }
    | null = null;
  if (args.discountCode && args.discountCode.trim()) {
    const promo = await resolveAndValidateDiscount({
      db: prisma,
      teacherId: teacher.id,
      studentId: student.id,
      code: args.discountCode,
      baseMinorUnits: basePriceMinorUnits,
    });
    if (promo.ok) {
      if (promo.discountMinorUnits > 0) {
        priceMinorUnits = promo.finalMinorUnits;
        applied = {
          type: "promo",
          codeId: promo.codeId,
          amountMinorUnits: promo.discountMinorUnits,
        };
      }
    } else if (promo.reason === "not_found") {
      // Not a promo — maybe a referral code.
      const ref = await resolveReferralForCheckout({
        db: prisma,
        teacherId: teacher.id,
        studentId: student.id,
        studentEmail: student.email,
        code: args.discountCode,
        baseMinorUnits: basePriceMinorUnits,
      });
      if (ref.ok) {
        priceMinorUnits = ref.finalMinorUnits;
        applied = {
          type: "referral",
          referralCodeId: ref.referralCodeId,
          ownerStudentId: ref.ownerStudentId,
          amountMinorUnits: ref.discountMinorUnits,
        };
      } else if (ref.reason === "not_a_referral") {
        return { error: discountRejectMessage("not_found", usesEnglishCopy(locale)) };
      } else {
        return { error: referralRejectMessage(ref.reason, usesEnglishCopy(locale)) };
      }
    } else {
      return { error: discountRejectMessage(promo.reason, usesEnglishCopy(locale)) };
    }
  }

  // A steep discount (a 100% referral, or a fixed amount ≥ the price) — or just
  // a low base price in a strong currency — can drive the charge to 0 or below
  // Stripe's minimum charge. Passing that into createCheckoutSession throws
  // AFTER the pending rows are written, orphaning them and 500-ing the student.
  // Validate the final amount here, BEFORE any rows are created, and fail with a
  // clear message. The minimum is per-currency (D-64): a Connect teacher priced
  // in GBP/USD/EUR must not be blocked by MXN's 10.00 gate.
  if (priceMinorUnits === 0) {
    return {
      error: en
        ? "This code makes the class free — ask your teacher to book it for you directly."
        : "Este código deja la clase gratis — pídele a tu profe que la agende directamente.",
    };
  }
  // Resolve the chosen instrument before creating rows. Doing it here rather
  // than inside the transaction means a student who picked an instrument the
  // teacher disabled between page load and submit gets a clean error instead
  // of a CHECK-constraint violation, and no Package row is orphaned.
  let instrument = null;
  if (paymentMethod === "manual_transfer") {
    if (!args.instrumentId) {
      return {
        error: en
          ? "Choose how you'd like to transfer."
          : "Elige cómo quieres hacer la transferencia.",
      };
    }
    instrument = await resolveOfferableInstrument(prisma, {
      teacherId: teacher.id,
      instrumentId: args.instrumentId,
      currency,
    });
    if (!instrument) {
      return {
        error: en
          ? "That payment option isn't available anymore. Pick another one."
          : "Esa opción de pago ya no está disponible. Elige otra.",
      };
    }
  }

  const stripeMinMinorUnits = stripeMinChargeMinorUnits(currency);
  if (paymentMethod === "stripe" && priceMinorUnits < stripeMinMinorUnits) {
    // Format the minimum in the teacher's actual pricing currency.
    const minMajor = (stripeMinMinorUnits / 10 ** currencyExponent(currency)).toLocaleString(
      en ? "en-US" : "es-MX",
      {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      },
    );
    // Only point at a transfer when this teacher actually offers one
    // (Connect-circle teachers often don't).
    const transferHint = hasOfferableInstrument(await instrumentsFor(teacher.id), currency)
      ? en
        ? " Choose a bank transfer to use it."
        : " Elige una transferencia para usarlo."
      : "";
    return {
      error: en
        ? `That total is below the card-payment minimum (${minMajor} ${currency}).${transferHint}`
        : `Ese total queda por debajo del mínimo para pago con tarjeta (${minMajor} ${currency}).${transferHint}`,
    };
  }

  // Create pending Package + Payment in a single transaction so a
  // failure on Stripe's side doesn't leave orphan rows. For Wise we
  // generate the reference inside the same transaction so the unique
  // index can catch a collision atomically (vanishingly unlikely with
  // UUIDv4 entropy, but free to enforce).
  const { paymentId, externalReference, packageId, paymentReference, teacherNotifId } =
    await prisma.$transaction(async (tx) => {
      const pkg = await tx.package.create({
        data: {
          teacherId: teacher.id,
          studentId: student.id,
          templateId: template.id,
          classesTotal: template.classCount,
          classesUsed: 0,
          classDurationMin: template.classDurationMin,
          pricePaidMinorUnits: priceMinorUnits,
          currency,
          purchasedAt: new Date(),
          intendedStartUtc,
          status: "pending",
        },
      });
      // A manual transfer must insert `payment_reference` and `instrument_id`
      // in the same row as `provider='manual_transfer'` — the CHECK
      // constraints `payments_reference_required_for_manual_transfer` and
      // `payments_instrument_required_for_manual_transfer` both reject a NULL
      // on insert, so a two-step insert+update is not available. Generate the
      // UUID in app code, derive the reference from it, and write everything
      // atomically. The reference stays a pure function of the UUID so it is
      // reproducible if a migration ever has to backfill it.
      const preExternalReference = paymentMethod === "manual_transfer" ? crypto.randomUUID() : null;
      const paymentReference =
        preExternalReference !== null ? generatePaymentReference(preExternalReference) : null;
      const created = await tx.payment.create({
        data: {
          packageId: pkg.id,
          amountMinorUnits: priceMinorUnits,
          currency,
          status: "pending",
          provider: paymentMethod,
          ...(preExternalReference !== null ? { externalReference: preExternalReference } : {}),
          ...(paymentReference !== null ? { paymentReference } : {}),
          ...(instrument !== null ? { instrumentId: instrument.id } : {}),
          ...(args.posthogSessionId ? { posthogSessionId: args.posthogSessionId } : {}),
        },
        select: { id: true, externalReference: true },
      });

      // Record the code application in the same transaction as the rows it
      // priced, so the charged amount and the record can't drift. The unique
      // (package_id)/(payment_id) indexes make this exactly-once per purchase.
      if (applied?.type === "promo") {
        await tx.discountRedemption.create({
          data: {
            discountCodeId: applied.codeId,
            teacherId: teacher.id,
            studentId: student.id,
            packageId: pkg.id,
            paymentId: created.id,
            amountMinorUnits: applied.amountMinorUnits,
            currency,
          },
        });
      } else if (applied?.type === "referral") {
        // Attributed now; qualified + the referrer reward minted when this
        // payment settles (grant-referral-reward Inngest function).
        await tx.referral.create({
          data: {
            teacherId: teacher.id,
            referralCodeId: applied.referralCodeId,
            referredStudentId: student.id,
            packageId: pkg.id,
            paymentId: created.id,
            referredDiscountMinorUnits: applied.amountMinorUnits,
            currency,
            status: "attributed",
          },
        });
      }

      // Teacher heads-up that a transfer checkout just opened. Stripe has its
      // own automated reconciliation, so we don't enqueue a teacher email
      // for that path. Inngest event is emitted after the tx commits.
      const teacherNotifId =
        paymentMethod === "manual_transfer"
          ? await enqueuePaymentPendingTeacher(tx, {
              teacherId: teacher.id,
              paymentId: created.id,
            })
          : null;

      return {
        paymentId: created.id,
        externalReference: created.externalReference,
        packageId: pkg.id,
        paymentReference,
        teacherNotifId,
      };
    });

  if (teacherNotifId) {
    await emitNotificationQueued({
      notificationId: teacherNotifId,
      teacherId: teacher.id,
    });
  }

  // Merge the browsing identity into the buyer's before the purchase events
  // fire. Everything up to here was recorded against posthog-js's anonymous id;
  // everything from here keys on student.id. PostHog funnels group by person, so
  // without this the funnel reports 100% drop-off after the page view — which is
  // exactly what the 2026-07-29 production test purchase produced. Checkout is
  // the first moment both ids are known. Best-effort and non-blocking.
  const browserIdentity = await currentPostHogIdentity();
  if (browserIdentity.distinctId) {
    aliasServerUser(student.id, browserIdentity.distinctId);
  }

  // Top of the payment funnel. Fired for both rails before the redirect so
  // we can measure per-rail completion (vs. payment_received) and, for the
  // Stripe card rail, how many checkouts students start but abandon on the
  // hosted page. sessionId stitches this onto the same recording the later
  // payment_received carries (both keyed off the Payment row's session id).
  trackServerEvent({
    name: "checkout_started",
    distinctId: student.id,
    sessionId: args.posthogSessionId || undefined,
    properties: {
      teacherId: teacher.id,
      packageId,
      paymentId,
      // The instrument kind, not the provider: `wise` keeps its historical
      // meaning so existing PostHog funnels survive, and `bank_transfer` is a
      // new value rather than a re-labelling of an old one.
      //
      // The `scheme` property that used to ride alongside is gone with D-145's
      // removal of `bank_account`: it named the account format so per-country
      // adoption was measurable without splitting the rail dimension. It stops
      // being emitted rather than being emitted empty, so events that already
      // carry it keep meaning what they meant.
      method: instrument ? railForKind(instrument.kind) : "stripe",
      priceMinorUnits,
      source: args.source,
      // Carried from the first-touch cookie so the purchase can be attributed
      // to the channel that produced it without a cross-event join. Empty on
      // the portal path (a signed-in repurchase has no acquisition channel)
      // and whenever the visitor arrived with no UTMs or referrer.
      ...attributionProperties(await currentAttribution()),
    },
  });

  // The in-product acquisition ledger (D-125). THIS is the last point in the
  // funnel where the visitor's first-touch cookie is readable — a settled
  // payment arrives on a webhook with no browser attached — so the attribution
  // is captured here and the later `purchase` row copies it back off this one.
  await recordBookingStarted({
    teacherId: teacher.id,
    packageId,
    studentId: student.id,
    viaReferral: applied?.type === "referral",
  });

  // Separate events so the discount/referral funnels are measurable without
  // bloating checkout_started. priceMinorUnits here is the post-discount charge.
  if (applied?.type === "promo") {
    trackServerEvent({
      name: "discount_applied",
      distinctId: student.id,
      sessionId: args.posthogSessionId || undefined,
      properties: {
        teacherId: teacher.id,
        packageId,
        paymentId,
        discountMinorUnits: applied.amountMinorUnits,
        chargedMinorUnits: priceMinorUnits,
      },
    });
  } else if (applied?.type === "referral") {
    trackServerEvent({
      name: "referral_attributed",
      distinctId: student.id,
      sessionId: args.posthogSessionId || undefined,
      properties: {
        teacherId: teacher.id,
        packageId,
        paymentId,
        discountMinorUnits: applied.amountMinorUnits,
      },
    });
  }

  if (paymentMethod === "manual_transfer") {
    // The instructions page reads the payment row by its reference, so the
    // redirect target is `/b/<slug>/buy/transfer/<ref>`. We don't expose the
    // externalReference UUID in this URL — it keeps things human-friendly and
    // matches the reference the student is about to paste into their transfer.
    // The old `/buy/wise/<ref>` path still resolves (students hold it in tabs
    // and emails) and redirects here.
    return {
      mode: "redirect",
      redirectTo: `/b/${teacher.bookingSlug}/buy/transfer/${paymentReference}`,
      externalReference,
    };
  }

  let stripe;
  try {
    stripe = getStripeClient();
  } catch {
    // Stripe not configured on this deploy (should be unreachable — the
    // teacher wouldn't have stripeChargesEnabled without platform creds).
    // Fail soft instead of crashing the checkout form.
    return {
      error: en
        ? "Card payments aren't available right now. Try a bank transfer, or come back later."
        : "Los pagos con tarjeta no están disponibles en este momento. Intenta con una transferencia o vuelve más tarde.",
    };
  }
  const uiMode = args.stripeUiMode ?? "hosted";
  const metadata = {
    teacher_id: teacher.id,
    package_id: packageId,
    external_reference: externalReference,
  };

  // Embedded: a single return_url, Stripe substitutes {CHECKOUT_SESSION_ID}.
  // Hosted: separate success/cancel urls (unchanged from before).
  const returnUrl = `${appUrl}/b/${teacher.bookingSlug}/buy/result?ref=${externalReference}&session_id={CHECKOUT_SESSION_ID}`;
  const successUrl = `${appUrl}/b/${teacher.bookingSlug}/buy/result?ref=${externalReference}`;
  const cancelUrl = `${appUrl}/b/${teacher.bookingSlug}/buy/result?ref=${externalReference}&canceled=1`;

  // client_reference_id is the Payment's external_reference so the
  // webhook can resolve the Payment row idempotently.
  // A Customer on HER account, so the session can offer bank transfer (SPEI in
  // Mexico). `customer_balance` funds a customer's cash balance and Stripe
  // refuses the session without one — `customer_creation: "always"` does not
  // satisfy it. Find-or-create, so a returning student stays one buyer in her
  // dashboard rather than one per purchase.
  //
  // Best-effort on purpose: this is an EXTRA payment method, and a Stripe blip
  // here must not cost the student the checkout they can already complete on a
  // card. Failing soft drops bank transfer for this one session and nothing
  // else.
  let checkoutCustomerId: string | undefined;
  try {
    checkoutCustomerId = await stripe.ensureCheckoutCustomer({
      connectedAccountId: teacher.stripeAccountId as string,
      email: student.email as string,
      name: student.name,
    });
  } catch (error) {
    log.warn("checkout customer lookup failed", {
      teacherId: teacher.id,
      externalReference,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Stripe is a network call to someone else's service, so it fails for
  // reasons that have nothing to do with this buyer: a revoked key, a
  // connected account that no longer exists, an outage. Until now those threw
  // out of the action and hit the error boundary, so the buyer lost the whole
  // checkout — the form, their typed details and their chosen class time —
  // and got a full-page "Something went wrong" with nothing to retry.
  //
  // Returning the error instead keeps them on the page with everything they
  // entered still there, which for a transient failure is the difference
  // between a retry and an abandoned sale. Observed on preview as a Stripe 403
  // (`account_invalid`) taking down the entire page.
  //
  // The Package and Payment rows created above are left pending on purpose:
  // `supersedePendingCheckouts` retires them on the next attempt, which is
  // exactly what it already does for a buyer who abandons at the Stripe page.
  let session: Awaited<ReturnType<typeof stripe.createCheckoutSession>>;
  try {
    session = await stripe.createCheckoutSession({
      // Direct charge on HER account (D-143). railReadinessError() above has
      // already refused this path when stripeAccountId is null, so the
      // non-null assertion is guarded rather than hopeful.
      connectedAccountId: teacher.stripeAccountId as string,
      clientReferenceId: externalReference,
      uiMode,
      ...(uiMode === "embedded" ? { returnUrl } : { successUrl, cancelUrl }),
      customerEmail: student.email as string,
      ...(checkoutCustomerId ? { customerId: checkoutCustomerId } : {}),
      // Picks the bank-transfer variant (mx_bank_transfer for Mexico). Her
      // country, not the student's — offerable methods are the MERCHANT's.
      ...(teacher.country ? { merchantCountry: teacher.country } : {}),
      lineItem: {
        name: `${template.name} — ${teacher.name}`,
        description: `${template.classCount} ${
          template.classCount === 1 ? "clase" : "clases"
        } de ${template.classDurationMin} minutos`,
        amountMinorUnits: priceMinorUnits,
        // Charge in the row's settlement currency (lowercase for Stripe). Matches
        // the Payment.currency the webhook guard validates against; "mxn" today.
        currency: currency.toLowerCase(),
      },
      metadata,
      // Tax is computed only once the platform registers + flips STRIPE_TAX_ENABLED
      // (global-launch item 7), and the billing address is now collected on the
      // SAME flag rather than unconditionally.
      //
      // It used to be `required` always, to bank an address for the day tax gets
      // switched on. That readiness was being paid for by every student, on the
      // highest-abandonment screen in the product: `required` puts country, line
      // 1, city, state and postcode in front of someone who is trying to buy a
      // Spanish class, for a capability with no registration behind it yet. On
      // the STUDENT rail that trade is not worth it — see D-144.
      //
      // `auto` does not mean "nothing": Stripe still collects whatever the chosen
      // payment method needs (typically postcode/country on a card), and
      // `capturedBillingFromAddress` already stores a partial address and skips
      // cleanly when nothing came back. What is genuinely given up is a COMPLETE
      // address on pre-registration payments — those rows keep whatever Stripe
      // asked for and nothing more. Tax is computed from the address collected at
      // the time of the charge, so this cannot affect a sale taxed later; it only
      // means historical rows are thinner than they would have been.
      //
      // The teacher's own subscription checkout is deliberately NOT changed (see
      // createSubscriptionCheckoutSession) — that is the platform's own sale,
      // where the address is a billing record rather than readiness.
      billingAddressCollection: stripeTaxEnabled() ? "required" : "auto",
      automaticTax: stripeTaxEnabled(),
    });
  } catch (error) {
    log.error("stripe checkout session failed", error, {
      teacherId: teacher.id,
      externalReference,
    });
    return { error: stripeUnavailableMessage(en) };
  }

  await prisma.payment.update({
    where: { id: paymentId },
    data: { stripeCheckoutSessionId: session.id },
  });

  if (uiMode === "embedded") {
    if (!session.client_secret) {
      return {
        error: en
          ? "Stripe didn't return a payment form. Try again."
          : "Stripe no devolvió un formulario de pago. Vuelve a intentarlo.",
      };
    }
    return { mode: "embedded", clientSecret: session.client_secret, externalReference };
  }
  if (!session.url) {
    return {
      error: en
        ? "Stripe didn't return a payment link. Try again."
        : "Stripe no devolvió un enlace de pago. Vuelve a intentarlo.",
    };
  }
  return { mode: "redirect", redirectTo: session.url, externalReference };
}
