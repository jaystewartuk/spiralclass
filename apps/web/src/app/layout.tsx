import { THEME_COLOR } from "@/lib/theme-color";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Atkinson_Hyperlegible, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { SiteFooter } from "@/components/site-footer";
import { LanguagePicker } from "@/components/language-picker";
import { LocaleProvider } from "@/components/locale-provider";
import { ReportProblemProvider } from "@/components/report-problem-provider";
import { PostHogProvider } from "@/components/posthog-provider";
import { ServerActionRecoveryListener } from "@/components/server-action-recovery-listener";
import { InstallPromptCapture } from "@/components/pwa/install-prompt-capture";
import { CallSessionProvider } from "@/lib/video/call-session-context";
import { CallSessionOverlay } from "@/components/video/call-session-overlay";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { LOCALES, type AppLocale } from "@spiralclass/shared";
import { readingStyle } from "@/lib/reading";
import { getReadingPreferences } from "@/lib/reading-server";
import "./globals.css";

// Atkinson Hyperlegible carries everything (D-140). It was drawn by the Braille
// Institute for low vision, and the mechanism transfers to dyslexia: characters
// that are commonly confused are given genuinely different shapes rather than
// mirrored ones — `b d p q` are not rotations of one form, `I l 1` are three
// distinct strokes.
//
// There is deliberately no display face. A second typeface for headings is the
// obvious way to add hierarchy, and it is the wrong one here: it would put a
// high-contrast serif at 17px inside dashboard cards, which is where Fraunces
// was. Hierarchy comes from scale, the ink depth ramp and space instead.
const sans = Atkinson_Hyperlegible({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-sans",
});

// Figures only: money in ~40 currencies, class times across timezones, balances
// compared down a column. Monospaced faces are also one of the few type choices
// with direct support in the dyslexia reading literature.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

const APP_URL = process.env.APP_URL ?? "https://spiralclass.com";

// Open Graph wants region-qualified locale tags (`en_US`, not bare `en`),
// which don't always match `LOCALES[].languageCode` — keyed separately so a
// new `LOCALES` entry forces a deliberate OG tag choice here too.
const OG_LOCALE: Record<AppLocale, string> = {
  "es-MX": "es_MX",
  en: "en_US",
  fr: "fr_FR",
};

// Metadata follows the request locale so the meta description / og:locale
// always match the language the page body actually renders in. Crawlers send
// no locale cookie and resolve to the default (en) — a static Spanish
// description here would put a Spanish SERP snippet on an English page.
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getPreferredLocale();
  const t = await getT();
  return {
    metadataBase: new URL(APP_URL),
    title: {
      default: "SpiralClass",
      template: "%s · SpiralClass",
    },
    description: t("web.layout.meta.description"),
    applicationName: "SpiralClass",
    openGraph: {
      type: "website",
      siteName: "SpiralClass",
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.map((l) => l.tag)
        .filter((tag) => tag !== locale)
        .map((tag) => OG_LOCALE[tag as AppLocale]),
    },
    twitter: { card: "summary_large_image" },
  };
}

// See lib/theme-color.ts for why these two constants live in their own module
// (short version: it is the one design value no guard could reach).
export const viewport: Viewport = { themeColor: [...THEME_COLOR] };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getPreferredLocale();
  const reading = await getReadingPreferences();
  const t = await getT();
  // Per-request CSP nonce minted in middleware (x-nonce). Passed to next-themes
  // so its pre-paint no-flash script carries the nonce and survives CSP enforcement.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable}`}
      // Applied on the server so the first paint is already at the reader's
      // size and spacing. Reading it client-side after hydration would reflow
      // the page under her, which is worse than not offering the control.
      style={readingStyle(reading) as React.CSSProperties}
    >
      <body className="bg-background text-foreground min-h-dvh font-sans">
        <a
          href="#main-content"
          className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
        >
          {t("web.layout.skipToContent")}
        </a>
        <ServerActionRecoveryListener />
        <PostHogProvider>
          <ThemeProvider nonce={nonce}>
            <LocaleProvider locale={locale}>
              <ReportProblemProvider>
                <CallSessionProvider>
                  <div
                    id="main-content"
                    tabIndex={-1}
                    className="animate-fade-in-up focus:outline-hidden"
                  >
                    {children}
                  </div>
                  <Toaster />
                  <SiteFooter localeToggle={<LanguagePicker />} />
                  {/* Rendered here (root layout — survives every client-side
                    navigation) rather than by the call page itself, so a call
                    started on /dashboard/classes/[id]/call keeps running
                    (and can be minimized to a bubble) while the user
                    navigates elsewhere, e.g. to chat. See
                    call-session-context.tsx's top note. */}
                  <CallSessionOverlay />
                  {/* Renders nothing. It starts listening for
                    `beforeinstallprompt` here, in the root layout, because
                    Chrome fires that event once and early — a listener the
                    settings route registers when it mounts gets nothing on
                    every client-side navigation into it. */}
                  <InstallPromptCapture />
                </CallSessionProvider>
              </ReportProblemProvider>
            </LocaleProvider>
          </ThemeProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
