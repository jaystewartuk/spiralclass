// Support contact. The rich path is the in-app "Report a problem" dialog
// (src/components/report-problem-dialog.tsx) — it attaches the page, the
// browser, an optional screenshot and the last Sentry event. This constant is
// the plain-mailto floor: /terms needs a literal address, and the dialog falls
// back to `supportMailto()` on a deploy with no Sentry DSN, so a report is
// never simply dropped.
//
// The privacy policy does NOT use this address: it has its own
// `PRIVACY_CONTACT_EMAIL` in @spiralclass/shared (legal/privacy-policy.ts),
// because a data-subject request should land somewhere separable from general
// support.

export const SUPPORT_EMAIL = "support@spiralclass.com";

// Set NEXT_PUBLIC_SUPPORT_WHATSAPP to the support WhatsApp number (digits
// only, including country code, e.g. 5215512345678 for a Mexican mobile).
// When absent the WhatsApp support CTA is hidden everywhere in the app.
export const SUPPORT_WHATSAPP = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP ?? "";

export type SupportWhatsAppContext = {
  page?: string;
  userId?: string | null;
  replayUrl?: string | null;
};

// Pure URL builder — separated from the env constant so tests can exercise it
// with any number without mocking env vars.
export function buildWhatsAppUrl(number: string, ctx: SupportWhatsAppContext = {}): string | null {
  const digits = number.replace(/\D/g, "");
  if (!digits) return null;
  const lines = ["Hola, necesito ayuda con SpiralClass."];
  if (ctx.page) lines.push(`Página: ${ctx.page}`);
  if (ctx.userId) lines.push(`Usuario: ${ctx.userId}`);
  if (ctx.replayUrl) lines.push(`Sesión: ${ctx.replayUrl}`);
  return `https://wa.me/${digits}?text=${encodeURIComponent(lines.join("\n"))}`;
}

// Opens the correct WhatsApp deep-link pre-filled with the caller's context.
// Returns null when NEXT_PUBLIC_SUPPORT_WHATSAPP is not configured.
export function supportWhatsAppUrl(ctx: SupportWhatsAppContext = {}): string | null {
  return buildWhatsAppUrl(SUPPORT_WHATSAPP, ctx);
}

// Plain `mailto:` for the no-Sentry path (a local or self-hosted deploy with
// no NEXT_PUBLIC_SENTRY_DSN), so a report reaches the same inbox in the same
// shape as a Sentry-backed one.
export function supportMailto(subject: string, body: string): string {
  const query = new URLSearchParams({ subject, body }).toString();
  return `mailto:${SUPPORT_EMAIL}?${query}`;
}
