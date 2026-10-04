import { ImageResponse } from "next/og";
import { MARK_SMALL, createT, isAppLocale, palette } from "@spiralclass/shared";
import { hasStripeCreds } from "@/lib/env";
import { ogFonts } from "@/lib/og-font";
import { SOCIAL_CARD_SIZE } from "@/lib/seo/social-card";

// The card a link preview shows for every page outside the booking funnel
// (which has its own, in the teacher's buyers' language). Its copy was
// hardcoded Spanish for a product whose UI is Spanish, English and French — so
// every share into an English or French context carried a Spanish sentence.
//
// The language is in the URL, `/social-card/es`, because a crawler fetching a
// card sends no cookie and no Accept-Language. It was the file convention
// `app/opengraph-image.tsx`, which has one URL, so every page's card was
// English — `/es/pricing` previewed as an English card under a Spanish title
// (D-193). The page names its card through `socialCardImages()`.
//
// Cached for a day, not a year. Next's `ImageResponse` defaults to
// `immutable`, which is safe only for a URL carrying a content hash, and this
// one has none to carry: the design is code and the copy is the catalog. A
// year-long pin on an unhashed URL is the failure
// tests/config/cache-unstable-asset-paths.test.ts records three times over.
const CARD_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

export async function GET(_req: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  if (!isAppLocale(locale)) return new Response("Not found", { status: 404 });
  const t = createT(locale);
  const fonts = ogFonts();
  const stripeAvailable = hasStripeCreds();
  const subText = stripeAvailable ? t("web.og.subWithStripe") : t("web.og.sub");
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 88px",
        background: palette.background,
        // Was the literal "serif". The plan recorded this as "no font loaded
        // into the ImageResponse", which was true and not the whole story: the
        // card also ASKED for a serif, so supplying the brand face alone would
        // have changed nothing. Both halves had to go.
        fontFamily: "Atkinson Hyperlegible",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <svg width="96" height="96" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <rect width="64" height="64" rx="14" fill={palette.primary} />
          <path
            d={MARK_SMALL.full}
            stroke={palette.background}
            strokeWidth={MARK_SMALL.strokeWidth}
            strokeLinecap="round"
            fill="none"
            transform="translate(10 10) scale(0.9)"
          />
        </svg>
        <span
          style={{
            fontSize: 56,
            fontWeight: 600,
            color: palette.text,
            letterSpacing: -1.5,
          }}
        >
          spiralclass
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <h1
          style={{
            fontSize: 88,
            fontWeight: 600,
            color: palette.text,
            lineHeight: 1.05,
            letterSpacing: -2,
            margin: 0,
            maxWidth: 980,
          }}
        >
          {t("web.landing.headline")}
        </h1>
        <p
          style={{
            fontSize: 32,
            color: palette.textMuted,
            margin: 0,
            maxWidth: 920,
          }}
        >
          {subText}
        </p>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 24, color: palette.textMuted }}>spiralclass.com</span>
      </div>
    </div>,
    // Without `fonts` Satori rasterises in its default serif — see lib/og-font.ts.
    { ...SOCIAL_CARD_SIZE, fonts, headers: { "Cache-Control": CARD_CACHE_CONTROL } },
  );
}
