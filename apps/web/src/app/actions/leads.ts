"use server";

import { issueMessage } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { leadCaptureSchema } from "@/lib/validators";
import { normalizeE164 } from "@/lib/phone";
import { z } from "zod";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { notifyTeacherOfLead } from "@/lib/leads/notify-teacher";
import { applyLeadStatus, leadStatusSchema } from "@/lib/leads/status";
import { createT, isAppLocale, publicFunnelLocaleFor, DEFAULT_LOCALE } from "@spiralclass/shared";
import { INSTRUMENT_READINESS_SELECT, isPubliclyListed } from "@/lib/marketplace-ready";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { attributionProperties, currentAttribution } from "@/lib/analytics/attribution";
import { recordEnquiry } from "@/lib/marketing/events";
import { revalidateAfterAction } from "@/lib/revalidate";

export type LeadCaptureState = { error?: string; ok?: boolean } | undefined;

// Public booking-page lead capture. Runs on the anonymous /b/[slug] route — no
// authenticated user — and mirrors the shape of createCheckoutIntent: parse the
// form, resolve the teacher by slug, write the row, fire analytics. Unlike
// checkout it never creates a Student or touches payments; a lead is just an
// enquiry the teacher follows up by hand. A failed teacher alert never fails
// the submission (best-effort), and analytics never block the response.
export async function captureLead(
  _prev: LeadCaptureState,
  formData: FormData,
): Promise<LeadCaptureState> {
  // This form lives on the public booking page, which speaks the language the
  // teacher chose for her buyers and never the visitor's (publicFunnelLocaleFor).
  // Its refusals used to follow the visitor's cookie, so a Spanish browser on
  // an English booking page got a Spanish error under an English form.
  //
  // The page's language arrives WITH the form rather than from a lookup by
  // slug, which is how checkout resolves it. A lookup would put a database read
  // ahead of the rate limiter on an anonymous endpoint, and the limiter comes
  // first here on purpose. The field is not trusted for anything but the
  // language of this response: it only picks which translation of a refusal
  // its own sender reads, and anything unrecognised falls back to the funnel's
  // default.
  const pageLocale = formData.get("pageLocale");
  const locale = publicFunnelLocaleFor(typeof pageLocale === "string" ? pageLocale : null);
  const t = createT(locale);
  const parsed = leadCaptureSchema(locale).safeParse({
    slug: formData.get("slug"),
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    phoneCountry: formData.get("phoneCountry") ?? undefined,
    message: formData.get("message"),
    posthogSessionId: formData.get("posthogSessionId"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }
  const input = parsed.data;

  // Honeypot. `website` is rendered as a visually-hidden, autocomplete-off
  // input no human ever sees, so anything in it came from a form-filling bot.
  // Return the success shape rather than an error: a bot told it failed
  // retries with the field cleared, whereas one told it succeeded moves on.
  // Deliberately checked before the rate limit so trivial bots never consume
  // a real visitor's IP budget on a shared NAT.
  if (typeof formData.get("website") === "string" && String(formData.get("website")).length > 0) {
    return { ok: true };
  }

  // This action is anonymous, writes a row, AND emails the teacher on every
  // submission — an email-amplification vector the moment the booking URL is
  // posted publicly. Checkout has been throttled on both axes since launch
  // (start-checkout.ts); this one never was. Same two-axis shape: a shared
  // NAT can't be starved by one abuser, and one abuser can't hide behind a
  // shared IP. Fails open if the limiter backend is down (rate-limit.ts).
  const ipRl = await rateLimit(await clientIp(), {
    scope: "lead-capture",
    limit: 6,
    windowMs: 60_000,
  });
  // Keyed on the address the alert would be sent about, so repeatedly
  // submitting the same identity to one teacher is capped over a long window
  // even from rotating IPs. Lowercased — casing must not mint a fresh bucket.
  const senderRl = ipRl.ok
    ? await rateLimit(`${input.slug}:${input.email.toLowerCase()}`, {
        scope: "lead-capture-sender",
        limit: 4,
        windowMs: 60 * 60_000,
      })
    : ipRl;
  if (!ipRl.ok || !senderRl.ok) {
    return {
      error: t("web.action.leads.tooMany"),
    };
  }

  const teacher = await prisma.teacher.findUnique({
    where: { bookingSlug: input.slug },
    select: {
      id: true,
      name: true,
      email: true,
      locale: true,
      bookingSlug: true,
      onboardingCompleteAt: true,
      disabledAt: true,
      photoPath: true,
      bio: true,
      templatesTouchedAt: true,
      availabilityTouchedAt: true,
      stripeChargesEnabled: true,
      pricingCurrency: true,
      payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
    },
  });
  // Same visibility rule as the booking landing page this form lives on
  // — defense in
  // depth in case this action is ever POSTed to directly.
  if (!teacher || !isPubliclyListed(teacher)) {
    return { error: t("web.action.teacherUnavailable") };
  }

  const phoneE164 = input.phone ? normalizeE164(input.phone, input.phoneCountry) : null;

  const lead = await prisma.lead.create({
    data: {
      teacherId: teacher.id,
      name: input.name,
      email: input.email,
      phoneE164,
      message: input.message ?? null,
    },
    select: { id: true },
  });

  trackServerEvent({
    name: "lead_captured",
    distinctId: input.posthogSessionId ?? `lead:${teacher.id}`,
    sessionId: input.posthogSessionId,
    properties: {
      teacherId: teacher.id,
      leadId: lead.id,
      hasPhone: Boolean(phoneE164),
      hasMessage: Boolean(input.message),
      // The other conversion this page produces. A channel that sends people
      // who enquire rather than buy looks dead on purchase data alone.
      ...attributionProperties(await currentAttribution()),
    },
  });

  // The in-product acquisition ledger (D-125): the same first-touch source the
  // PostHog event above carries, landed against the teacher's own funnel so
  // "which community sends people who actually write to me" is answerable in
  // the app. Best-effort by construction — the lead row is already committed.
  await recordEnquiry({ teacherId: teacher.id, leadId: lead.id });

  // Teacher alert (best-effort) + analytics flush, in the teacher's own locale.
  // The lead row is already committed, so a mail failure must never surface to
  // the visitor — swallow it (notifyTeacherOfLead also logs its own failures).
  try {
    await notifyTeacherOfLead({
      to: teacher.email,
      teacherName: teacher.name,
      bookingSlug: teacher.bookingSlug,
      locale: isAppLocale(teacher.locale) ? teacher.locale : DEFAULT_LOCALE,
      lead: {
        name: input.name,
        email: input.email,
        phone: phoneE164,
        message: input.message ?? null,
      },
    });
  } catch {
    // Already logged inside the helper; never fail the submission.
  }
  await flushAnalytics();

  return { ok: true };
}

// --- Teacher-side: move a lead through its lifecycle from the dashboard ---

const statusSchema = z.object({
  leadId: z.string().uuid(),
  status: leadStatusSchema,
});

export type LeadStatusState = { error?: string; ok?: boolean } | undefined;

export async function setLeadStatus(
  _prev: LeadStatusState,
  formData: FormData,
): Promise<LeadStatusState> {
  const t = createT(await getPreferredLocale());
  const parsed = statusSchema.safeParse({
    leadId: formData.get("leadId"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return { error: t("web.action.invalidData") };
  }

  const teacher = await requireOnboardedTeacher();
  // Shared core scopes the write by teacher_id and fires the transition event.
  const ok = await applyLeadStatus(teacher.id, parsed.data.leadId, parsed.data.status);
  if (!ok) {
    return { error: t("web.action.leads.notFound") };
  }

  revalidateAfterAction("/dashboard/leads");
  return { ok: true };
}
