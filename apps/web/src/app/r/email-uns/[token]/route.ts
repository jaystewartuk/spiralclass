import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { palette, type AppLocale } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { applyEmailOptOut } from "@/lib/email/opt-out-handler";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { escapeHtml } from "@/lib/html-escape";

// One-click unsubscribe for the email channel. Flips
// students.email_opt_in = false. Tokens are HMAC-signed (SESSION_SECRET)
// and expire after 90 days. Idempotent on repeat clicks.

// GET is SAFE/idempotent and never mutates. Corporate mail scanners (Defender
// Safe Links, Mimecast, Barracuda), Apple Mail Privacy Protection and Gmail
// link-prefetch all issue automated GETs against every link in an email — if
// GET unsubscribed, those would silently opt real users out before they read
// the message (RFC 8058). Instead we render a confirmation page whose button
// POSTs back; the List-Unsubscribe-Post one-click flow also targets POST.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  return new NextResponse(await unsubscribeConfirmHtml(token), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
}

// POST performs the actual opt-out: from the confirmation button, or from a
// mail client's RFC 8058 one-click `List-Unsubscribe-Post` request.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const env = serverEnv();
  const outcome = await applyEmailOptOut({ prisma, secret: env.SESSION_SECRET }, token);

  if (outcome.code === "invalid-token") {
    return new NextResponse(await unsubscribeErrorHtml(outcome.reason), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
    });
  }
  if (outcome.code === "not-found") {
    return new NextResponse(await unsubscribeErrorHtml("not-found"), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
    });
  }

  trackServerEvent({
    name: "email_opt_out",
    distinctId: outcome.studentId,
    properties: {
      teacherId: outcome.teacherId,
      studentId: outcome.studentId,
      idempotent: outcome.idempotent,
    },
  });
  await flushAnalytics();

  return new NextResponse(await unsubscribeSuccessHtml(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
}

// These pages are reachable from every email the product sends, so they
// resolve the locale from the request like any other page: the `locale` cookie
// if this browser has one, otherwise Accept-Language, otherwise
// DEFAULT_LOCALE.
//
// Not the recipient's stored `students.locale`, which would be the better
// signal: the token identifies the row, but rendering the GET confirmation
// would then mean a DB read on a request that is deliberately side-effect-free
// and is issued by every corporate link-scanner that touches the email. The
// browser asking is the one reading.
async function unsubscribeConfirmHtml(token: string): Promise<string> {
  const action = `/r/email-uns/${encodeURIComponent(token)}`;
  const [locale, t] = await Promise.all([getPreferredLocale(), getT()]);
  return renderUnsubscribePage({
    locale,
    title: t("web.unsubscribe.confirm.title"),
    heading: t("web.unsubscribe.confirm.heading"),
    paragraphs: [t("web.unsubscribe.confirm.body"), t("web.unsubscribe.confirm.push")],
    actionHtml: `<form method="POST" action="${escapeHtml(action)}" style="margin-top:8px"><button type="submit" class="btn">${escapeHtml(t("web.unsubscribe.confirm.cta"))}</button></form>`,
  });
}

async function unsubscribeSuccessHtml(): Promise<string> {
  const [locale, t] = await Promise.all([getPreferredLocale(), getT()]);
  return renderUnsubscribePage({
    locale,
    title: t("web.unsubscribe.done.title"),
    heading: t("web.unsubscribe.done.heading"),
    paragraphs: [t("web.unsubscribe.done.body"), t("web.unsubscribe.done.push")],
  });
}

async function unsubscribeErrorHtml(reason: string): Promise<string> {
  const [locale, t] = await Promise.all([getPreferredLocale(), getT()]);
  return renderUnsubscribePage({
    locale,
    title: t("web.unsubscribe.error.title"),
    heading: t("web.unsubscribe.error.heading"),
    // `reason` is escaped by renderUnsubscribePage along with the rest of the
    // paragraph, so it is interpolated raw here.
    paragraphs: [t("web.unsubscribe.error.body", { reason }), t("web.unsubscribe.error.help")],
  });
}

// Branded full-page chrome mirroring the email + web app identity.
// Kept inline (rather than reusing renderBrandedEmailHtml) so the page
// can stretch to viewport width and use real web fonts without
// email-client compatibility constraints.
function renderUnsubscribePage(args: {
  locale: AppLocale;
  title: string;
  heading: string;
  paragraphs: string[];
  actionHtml?: string;
}): string {
  const paragraphsHtml =
    args.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") + (args.actionHtml ?? "");
  return `<!doctype html>
<html lang="${args.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(args.title)} · SpiralClass</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<!-- No webfont link: it loaded Fraunces and Plus Jakarta Sans, both retired
       by D-140, and fetched from Google on every open. -->
<style>
  :root {
    --bg: ${palette.background};
    --fg: ${palette.text};
    --primary: ${palette.primary};
    --border: ${palette.border};
    --card: ${palette.surface};
    --muted: ${palette.textMuted};
    --accent: ${palette.gold};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: 'Atkinson Hyperlegible', Verdana, Tahoma, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    line-height: 1.6;
  }
  .wrap {
    max-width: 560px;
    margin: 0 auto;
    padding: 48px 20px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 28px;
  }
  .brand-mark {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: var(--primary);
    display: grid;
    place-items: center;
  }
  .brand-word {
    font-family: 'Atkinson Hyperlegible', Verdana, Tahoma, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 22px;
    font-weight: 600;
    color: var(--fg);
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 36px 32px;
  }
  h1 {
    margin: 0 0 14px 0;
    font-family: 'Atkinson Hyperlegible', Verdana, Tahoma, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-weight: 600;
    font-size: 26px;
    line-height: 1.2;
  }
  p {
    margin: 0 0 14px 0;
    font-size: 16px;
    color: var(--fg);
  }
  p:last-child { margin-bottom: 0; }
  .btn {
    appearance: none;
    border: none;
    cursor: pointer;
    background: var(--primary);
    color: ${palette.background};
    font-family: inherit;
    font-size: 16px;
    font-weight: 600;
    padding: 12px 20px;
    border-radius: 10px;
    min-height: 44px;
  }
  .footer {
    margin-top: 18px;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
  @media (max-width: 520px) {
    .wrap { padding: 32px 16px; }
    .card { padding: 28px 22px; }
    h1 { font-size: 22px; }
  }
</style>
</head>
<body>
<main class="wrap">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 64 64">
        <path d="M55 32 A22 22 0 0 1 11 32 A18 18 0 0 1 47 32 A14 14 0 0 1 19 32" fill="none" stroke="${palette.background}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M19 32 A10 10 0 0 1 39 32 A6.5 6.5 0 0 1 26 32" fill="none" stroke="${palette.background}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="32.5" cy="32" r="2" fill="${palette.gold}"/>
      </svg>
    </span>
    <span class="brand-word">spiralclass</span>
  </div>
  <section class="card">
    <h1>${escapeHtml(args.heading)}</h1>
    ${paragraphsHtml}
  </section>
  <div class="footer">SpiralClass · spiralclass.com</div>
</main>
</body>
</html>`;
}
