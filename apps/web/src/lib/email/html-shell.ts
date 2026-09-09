// Branded HTML chrome for transactional emails. Mirrors the web app's ink-and-
// gold identity (see globals.css and components/brand/logo.tsx)
// using table-based markup so it survives Outlook / Gmail / Apple Mail
// rendering quirks. No webfonts are loaded (see EMAIL_FONT); the stack degrades to
// Verdana and Tahoma, the same legible fallbacks the app's own stack uses.
//
// Color tokens are pulled from the shared brand palette (`@spiralclass/shared`)
// — the same source web and mobile read from — so the brand voice stays
// consistent across surfaces (web app, emails, unsubscribe page).
import { MARK, palette, type LanguageCode } from "@spiralclass/shared";

/**
 * The email type stack (D-140).
 *
 * Every declaration below named `'Plus Jakarta Sans'` — the face the product
 * used BEFORE D-140 — and the heading named `'Fraunces'`, the display face
 * D-140 removed rather than replaced. Neither is loaded by any mail client, so
 * both silently fell through to whatever the client picked: a system sans for
 * the body and, because the heading's own fallback chain ended in `serif`, a
 * serif for the heading. The result was a serif headline on a sans page, in a
 * brand whose entire typographic argument is one carefully chosen sans.
 *
 * Mail clients cannot load webfonts reliably, so Atkinson Hyperlegible is named
 * first for the few that have it and the fallbacks carry the rest. Verdana and
 * Tahoma lead them deliberately: they are the same fallbacks the app's own
 * stack uses, chosen because they are wide, open and unambiguous — the
 * properties D-140 selected Atkinson for in the first place.
 */
const EMAIL_FONT =
  "'Atkinson Hyperlegible',Verdana,Tahoma,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const BRAND = {
  bg: palette.background,
  fg: palette.text,
  primary: palette.primary,
  primaryFg: palette.primaryText,
  accent: palette.gold,
  border: palette.border,
  cardBg: palette.surface,
  mutedFg: palette.textMuted,
  subtle: palette.textSubtle,
} as const;

export type EmailHtmlContent = {
  preheader: string;
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  // Displayed after the primary CTA as a monospaced numeric block — used when
  // the email carries both a clickable link and a typed-entry code.
  codeBlock?: string;
  // A lighter, text-style link rendered under the primary CTA (e.g. "Add to
  // calendar"). Kept visually secondary so it never competes with `cta`.
  secondaryLink?: { label: string; url: string };
  // Optional circular avatar shown above the heading — the inviting teacher's
  // profile photo on the invitation email. Must be an absolute https URL to a
  // hosted image (email clients strip data: images); omitted when the teacher
  // has no photo.
  avatarUrl?: string;
  // Optional benefit list rendered between the paragraphs and the CTA as a
  // check-marked bullet list (the invitation email's "why join" section).
  bullets?: string[];
};

export type BrandedEmailOptions = {
  // Outbound email/push copy is authored in Spanish + English only; any other
  // registered language (e.g. fr) falls back to English via the `=== "es_MX"`
  // branches below. Typed as the full LanguageCode so a UI locale flows through
  // without a narrowing cast at every call site.
  languageCode: LanguageCode;
  unsubscribeUrl?: string | null;
  // Sent on every email (teacher and student alike), unlike unsubscribeUrl
  // which is student-only and suppressed for teacher-recipient templates.
  notificationSettingsUrl?: string | null;
  // Absolute origin used to build the email logo URL. Gmail + Outlook strip
  // inline-SVG <img src="data:..."> tags, so the brand mark needs to be a
  // hosted PNG served from this origin (/brand/mark-ink.png). When absent
  // (tests, or rendering before the dispatcher had APP_URL wired) the
  // header falls back to the inline SVG used by clients that render it —
  // not ideal but better than no logo.
  appUrl?: string;
};

export function renderBrandedEmailHtml(
  content: EmailHtmlContent,
  options: BrandedEmailOptions,
): string {
  const lang = options.languageCode === "es_MX" ? "es-MX" : "en";
  const tagline =
    options.languageCode === "es_MX"
      ? "Clases, cobros y recordatorios sin la carga mental."
      : "Classes, payments and reminders without the mental load.";
  const sentBy =
    options.languageCode === "es_MX"
      ? "Enviado por SpiralClass · spiralclass.com"
      : "Sent by SpiralClass · spiralclass.com";
  const unsubLabel =
    options.languageCode === "es_MX"
      ? "Dejar de recibir estos correos"
      : "Unsubscribe from these emails";
  const notificationSettingsLabel =
    options.languageCode === "es_MX" ? "Configurar notificaciones" : "Manage notification settings";

  const paragraphsHtml = content.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:${BRAND.fg};">${escapeHtml(p)}</p>`,
    )
    .join("");

  const ctaHtml = content.cta
    ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px 0;">
                <tr>
                  <td align="center" style="background:${BRAND.primary};border-radius:10px;">
                    <a href="${safeHref(content.cta.url)}" style="display:inline-block;padding:13px 26px;color:${BRAND.primaryFg};text-decoration:none;font-weight:600;font-size:15px;font-family:${EMAIL_FONT};border-radius:10px;line-height:1.2;">${escapeHtml(content.cta.label)}</a>
                  </td>
                </tr>
              </table>`
    : "";

  const codeLabel = options.languageCode === "es_MX" ? "Tu código de acceso" : "Your sign-in code";
  // Real click-to-copy (a button invoking the Clipboard API) isn't achievable
  // here — Gmail, Outlook, and Apple Mail all strip <script> tags from email
  // HTML, so no JS can run inside the message. The best available substitute:
  // a 📋 glyph + explicit "select to copy" hint make clear the code is meant
  // to be copied, and the code sits ALONE in its own paragraph/cell (no
  // surrounding label text) so a double/triple-tap or click-drag selects
  // exactly the digits and nothing else.
  const copyHint =
    options.languageCode === "es_MX" ? "Toca para seleccionar y copiar" : "Tap to select and copy";
  const codeBlockHtml = content.codeBlock
    ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;width:100%;">
                <tr>
                  <td style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:8px;padding:16px 20px;text-align:center;">
                    <p style="margin:0 0 8px 0;font-size:12px;font-family:${EMAIL_FONT};color:${BRAND.mutedFg};font-weight:600;">${escapeHtml(codeLabel)} &nbsp;📋</p>
                    <p style="margin:0;font-size:28px;font-weight:700;letter-spacing:0.3em;color:${BRAND.fg};font-family:'Courier New',Courier,monospace;user-select:all;-webkit-user-select:all;">${escapeHtml(content.codeBlock)}</p>
                    <p style="margin:8px 0 0 0;font-size:11px;font-family:${EMAIL_FONT};color:${BRAND.mutedFg};">${escapeHtml(copyHint)}</p>
                  </td>
                </tr>
              </table>`
    : "";

  // Circular teacher avatar above the heading (invitation email). Only rendered
  // for a hosted https URL — data:/other schemes are dropped by safeHref and
  // would leave a broken image, so guard on the scheme here too.
  const avatarHtml =
    content.avatarUrl && /^https?:\/\//i.test(content.avatarUrl.trim())
      ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">
                <tr>
                  <td>
                    <img src="${safeHref(content.avatarUrl)}" width="64" height="64" alt="" style="display:block;border-radius:9999px;border:2px solid ${BRAND.border};width:64px;height:64px;object-fit:cover;">
                  </td>
                </tr>
              </table>`
      : "";

  const bulletsHtml =
    content.bullets && content.bullets.length > 0
      ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px 0;width:100%;">
                ${content.bullets
                  .map(
                    (b) => `<tr>
                  <td style="padding:5px 0;vertical-align:top;width:22px;color:${BRAND.primary};font-size:15px;line-height:1.5;">✓</td>
                  <td style="padding:5px 0;vertical-align:top;font-size:15px;line-height:1.5;color:${BRAND.fg};">${escapeHtml(b)}</td>
                </tr>`,
                  )
                  .join("")}
              </table>`
      : "";

  const secondaryLinkHtml = content.secondaryLink
    ? `
              <p style="margin:${content.cta ? "14px" : "20px"} 0 0 0;font-size:14px;line-height:1.5;font-family:${EMAIL_FONT};">
                <a href="${safeHref(content.secondaryLink.url)}" style="color:${BRAND.primary};text-decoration:underline;font-weight:500;">${escapeHtml(content.secondaryLink.label)}</a>
              </p>`
    : "";

  const footerLinks = [
    options.notificationSettingsUrl
      ? `<a href="${safeHref(options.notificationSettingsUrl)}" style="color:${BRAND.mutedFg};text-decoration:underline;">${escapeHtml(notificationSettingsLabel)}</a>`
      : null,
    options.unsubscribeUrl
      ? `<a href="${safeHref(options.unsubscribeUrl)}" style="color:${BRAND.mutedFg};text-decoration:underline;">${escapeHtml(unsubLabel)}</a>`
      : null,
  ].filter((link): link is string => link !== null);

  const unsubscribeRow =
    footerLinks.length > 0
      ? `
        <tr>
          <td style="padding:8px 4px 0 4px;font-size:12px;color:${BRAND.subtle};line-height:1.6;font-family:${EMAIL_FONT};">
            ${footerLinks.join(" &nbsp;·&nbsp; ")}
          </td>
        </tr>`
      : "";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(content.heading)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<!-- No webfont link. It loaded Fraunces and Plus Jakarta Sans, both retired
     by D-140, and most mail clients strip stylesheet links anyway — so it
     bought nothing while fetching from Google every time an email was
     opened in the clients that do honour it. The stack falls back to faces
     the reader already has. -->
<style>
  @media (max-width: 620px) {
    .ap-shell { padding: 20px 12px !important; }
    .ap-card { padding: 28px 22px !important; }
    .ap-heading { font-size: 22px !important; }
  }
  a { color: ${BRAND.primary}; }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:${EMAIL_FONT};color:${BRAND.fg};-webkit-font-smoothing:antialiased;">
<div style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;max-height:0;font-size:1px;line-height:1px;mso-hide:all;">${escapeHtml(content.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.bg};">
  <tr>
    <td align="center" class="ap-shell" style="padding:36px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">
        <tr>
          <td style="padding:0 4px 22px 4px;">
            ${renderHeader(options.appUrl)}
          </td>
        </tr>
        <tr>
          <td class="ap-card" style="background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:14px;padding:36px 34px;">
            ${avatarHtml}<h1 class="ap-heading" style="margin:0 0 18px 0;font-family:${EMAIL_FONT};font-size:26px;line-height:1.3;font-weight:700;color:${BRAND.fg};">${escapeHtml(content.heading)}</h1>
            ${paragraphsHtml}${bulletsHtml}${ctaHtml}${codeBlockHtml}${secondaryLinkHtml}
          </td>
        </tr>
        ${unsubscribeRow}
        <tr>
          <td style="padding:18px 4px 0 4px;font-size:12px;color:${BRAND.subtle};line-height:1.6;font-family:${EMAIL_FONT};">
            <div style="margin-bottom:4px;">${escapeHtml(tagline)}</div>
            <div>${escapeHtml(sentBy)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function renderHeader(appUrl: string | undefined): string {
  // Gmail, Outlook desktop and Outlook web all strip
  // `<img src="data:image/svg+xml…">` entirely, so a hosted PNG is the only
  // logo format that renders everywhere. It is generated from the shared mark
  // geometry by `pnpm brand:assets` at 2x (96px source, 48px displayed) — the
  // hand-made file it replaces was still the AgendaProfe monogram four days
  // after the rename, because nothing regenerated it.
  //
  // The inline SVG stays as the fallback for when appUrl is not wired (tests,
  // pre-dispatcher rendering); Apple Mail and iOS Mail render it. It is built
  // from the same MARK constant, so the two cannot drift.
  const logoSrc = appUrl
    ? `${appUrl.replace(/\/$/, "")}/brand/mark-ink.png`
    : `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="${MARK.viewBox}" fill="none" aria-hidden="true">` +
          `<path d="${MARK.rest}" stroke="${BRAND.primary}" stroke-width="${MARK.strokeWidth}" stroke-linecap="round"/>` +
          `<path d="${MARK.first}" stroke="${BRAND.accent}" stroke-width="${MARK.strokeWidth}" stroke-linecap="round"/>` +
          `</svg>`,
      )}`;
  // Verdana rather than a webfont: no mail client will load Atkinson
  // Hyperlegible, and Verdana is the closest widely-installed face with the
  // open, plain letterforms D-140 is about. `SpiralClass` in camel case, which
  // is how the name is written everywhere else.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;width:48px;">
                  <img src="${logoSrc}" width="48" height="48" alt="SpiralClass" style="display:block;border:0;outline:none;text-decoration:none;">
                </td>
                <td style="padding-left:12px;vertical-align:middle;font-family:Verdana,Tahoma,Geneva,sans-serif;font-size:21px;font-weight:700;color:${BRAND.fg};letter-spacing:-0.01em;">SpiralClass</td>
              </tr>
            </table>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Allow-list of URL schemes safe to put behind an email <a href>. Everything
// else (javascript:, data:, vbscript:, file: …) collapses to "#" so a
// malicious or malformed URL can't smuggle an active payload into a client
// that honours such schemes. URLs are app-built today (CTAs, calendar links,
// unsubscribe links), so this is defense-in-depth — it must not break the
// legitimate http(s)/mailto links we actually send. Relative URLs (leading
// "/", "#", "?") are kept too: they have no scheme and can't be active.
const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

function safeHref(url: string): string {
  const trimmed = url.trim();
  // Scheme-relative (`//host`) and path/anchor/query-relative links carry no
  // scheme of their own — treat them as safe and HTML-escape only.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const scheme = `${schemeMatch[1].toLowerCase()}:`;
    if (!SAFE_URL_SCHEMES.has(scheme)) return "#";
  }
  return escapeAttr(trimmed);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
