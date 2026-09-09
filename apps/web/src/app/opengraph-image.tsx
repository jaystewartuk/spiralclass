import { ImageResponse } from "next/og";
import { MARK_SMALL, palette } from "@spiralclass/shared";
import { hasStripeCreds } from "@/lib/env";
import { getT } from "@/lib/i18n";
import { ogFonts } from "@/lib/og-font";

// The card a link preview shows. Its copy was hardcoded Spanish for a product
// whose UI is Spanish, English and French — so every share into an English or
// French context carried a Spanish sentence.
export const alt = "SpiralClass";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const t = await getT();
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
          Da clases. Nosotros nos encargamos del resto.
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
    { ...size, fonts },
  );
}
