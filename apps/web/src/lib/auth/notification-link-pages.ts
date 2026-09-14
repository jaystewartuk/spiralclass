import { NextResponse } from "next/server";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { escapeHtml } from "@/lib/html-escape";
import type { NotificationLinkKind } from "@/lib/auth/notification-link";

// The two standalone pages behind a notification sign-in link: the button a
// reader presses to use it, and the page for a link that no longer works.
//
// Both render to a reader with no session, outside the app shell, so they
// resolve the locale from the request — the `locale` cookie if this browser
// has one, otherwise Accept-Language, otherwise DEFAULT_LOCALE — and build
// their own markup.
//
// The token is in the URL, so neither page may leak it onward: no external
// resource, no-referrer, and never cached.
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

const ROUTE_PREFIX: Record<NotificationLinkKind, string> = {
  rebook: "/r/re",
  "magic-link": "/r/ml",
};

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;min-height:44px;cursor:pointer}";

// Rendered on GET. Deliberately does nothing but offer a form: mail and chat
// link scanners issue a GET against every link they find, and a GET that
// signed someone in would spend the one use of the link before its reader
// ever saw it.
export async function notificationLinkConfirmResponse(
  kind: NotificationLinkKind,
  token: string,
): Promise<Response> {
  const [locale, t] = await Promise.all([getPreferredLocale(), getT()]);
  const action = `${ROUTE_PREFIX[kind]}/${encodeURIComponent(token)}`;
  const heading =
    kind === "rebook"
      ? t("web.notificationLink.rebookHeading")
      : t("web.notificationLink.signInHeading");
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(t("web.notificationLink.title"))}</title>
<style>${STYLE}</style>
</head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(t("web.notificationLink.body"))}</p><form method="POST" action="${escapeHtml(action)}"><button type="submit">${escapeHtml(t("web.notificationLink.cta"))}</button></form></body></html>`;
  return new NextResponse(html, { status: 200, headers: HEADERS });
}

// One page for every reason a link stopped working: unknown, used, lapsed, or
// no longer matching the row it was sent for. The rebook variant offers the way
// round — the classes page, through the ordinary sign-in.
//
// The link out is its own sentence rather than an <a> spliced into the middle
// of the prose — a sentence wrapped around markup can only be translated by
// translating the markup with it, which is a shape the catalog cannot hold.
export async function notificationLinkExpiredResponse(
  kind: NotificationLinkKind,
  status = 404,
): Promise<Response> {
  const [locale, t] = await Promise.all([getPreferredLocale(), getT()]);
  const body =
    kind === "rebook"
      ? `<p>${escapeHtml(t("web.expiredLink.reschedule"))}</p><p><a href="/my-classes">${escapeHtml(t("web.expiredLink.rescheduleAction"))}</a></p>`
      : `<p>${escapeHtml(t("web.expiredLink.signIn"))}</p>`;
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(t("web.expiredLink.title"))}</title>
<style>${STYLE}</style>
</head><body><h1>${escapeHtml(t("web.expiredLink.heading"))}</h1>${body}</body></html>`;
  return new NextResponse(html, { status, headers: HEADERS });
}
