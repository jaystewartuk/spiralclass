import { ImageResponse } from "next/og";
import { palette } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
// The buyer-facing formatter, the same one the page itself uses. It was
// `formatMinorUnits`, which renders "$380.00 MXN" where the landing page it
// previews renders "MX$380.00" — two spellings of one price, on the asset a
// buyer sees FIRST, in a feed, before they have any other context for the
// number. The card is generated with no visitor, so it formats in the
// teacher's own funnel locale, exactly as the page does.
import { formatPriceForBuyer, publicFunnelLocaleFor } from "@spiralclass/shared";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { INSTRUMENT_READINESS_SELECT, isPubliclyListed } from "@/lib/marketplace-ready";
import { getPublicFunnelT, PUBLIC_FUNNEL_LOCALE } from "@/lib/i18n";

// Per-teacher social card (WhatsApp / search / link previews). Mirrors the
// brand styling of the site-wide app/opengraph-image.tsx but leads with the
// teacher's name + starting price so a shared booking link looks personal
// and trustworthy. Falls back to the generic brand card if the teacher
// can't be resolved.
// Every string on the card resolves through getPublicFunnelT() — the SAME
// translator the page it previews uses, in the SAME (teacher's) locale.
// Hardcoding the copy here is what let the two drift: the card shipped the
// es-MX catalog's tagline verbatim, so a link shared to Facebook rendered a
// Spanish card above an English landing page. Route new copy through `t`
// rather than typing it inline, and the card cannot drift again.
//
// `alt` is the one exception, and it has to be: Next requires it as a static
// module export, evaluated with no request and so no teacher to read a locale
// from. It stays in the fallback locale. That is alt text on a social card —
// read by assistive tech and scrapers rather than shown to the buyer — so it
// is the one string on this surface where a fallback costs nothing.
export const alt = getPublicFunnelT(PUBLIC_FUNNEL_LOCALE)("web.bookingCard.alt");
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CREAM = palette.background;
const INK = palette.text;
const MUTED = palette.textMuted;
const BRAND = palette.primary;

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <svg width="72" height="72" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="64" rx="14" fill={BRAND} />
        <path
          d="M55 32 A22 22 0 0 1 11 32 A18 18 0 0 1 47 32 A14 14 0 0 1 19 32"
          fill="none"
          stroke={CREAM}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M19 32 A10 10 0 0 1 39 32 A6.5 6.5 0 0 1 26 32"
          fill="none"
          stroke={CREAM}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="32.5" cy="32" r="2" fill={palette.gold} />
      </svg>
      <span style={{ fontSize: 40, fontWeight: 600, color: INK, letterSpacing: -1 }}>
        spiralclass
      </span>
    </div>
  );
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const teacher = await prisma.teacher.findUnique({
    where: { bookingSlug: slug },
    select: {
      name: true,
      headline: true,
      photoPath: true,
      bio: true,
      updatedAt: true,
      bookingPageLocale: true,
      onboardingCompleteAt: true,
      disabledAt: true,
      templatesTouchedAt: true,
      availabilityTouchedAt: true,
      stripeChargesEnabled: true,
      pricingCurrency: true,
      payoutInstruments: { select: INSTRUMENT_READINESS_SELECT },
      packageTemplates: {
        where: { archived: false },
        orderBy: { priceMinorUnits: "asc" },
        take: 1,
        select: { priceMinorUnits: true, currency: true },
      },
    },
  });

  // isPubliclyListed — a not-yet-
  // Marketplace-Ready teacher's real name/photo/price shouldn't leak into a
  // social-preview card either, even though this route degrades to a generic
  // brand card instead of a hard 404 like the other 3 gated call sites.
  const published = teacher && isPubliclyListed(teacher);
  // The language she chose for her booking page, so the shared card and the
  // landing page it previews are in one language. A teacher we can't resolve
  // falls back, same as the generic card body below.
  const cardT = getPublicFunnelT(teacher?.bookingPageLocale);
  // The generic heading is STUDENT-facing, like everything else on this card:
  // it previews a student's booking link, so the teacher-acquisition headline
  // (web.landing.headline, "Teach. We handle the rest.") does not belong here
  // even though this fallback renders for a teacher who isn't listed yet. It
  // also matches this card's own `alt` text, which has always described the
  // image as "book your classes".
  const heading = published
    ? teacher.headline?.trim() || cardT("web.bookingLanding.classesWith", { name: teacher.name })
    : cardT("web.bookingCard.genericHeading");
  const cheapestTemplate = published ? teacher.packageTemplates[0] : undefined;
  const from = cheapestTemplate?.priceMinorUnits;

  // Embed the teacher photo as a data URL so a fetch failure degrades to "no
  // avatar" instead of breaking the whole card. Best-effort.
  let photoDataUrl: string | null = null;
  const photoUrl = published
    ? teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime())
    : null;
  if (photoUrl) {
    try {
      const res = await fetch(photoUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        photoDataUrl = `data:${ct};base64,${buf.toString("base64")}`;
      }
    } catch {
      // ignore — render without the avatar
    }
  }

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 88px",
        background: CREAM,
        fontFamily: "serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Brand />
        {photoDataUrl && (
          <img
            src={photoDataUrl}
            width={140}
            height={140}
            style={{ width: 140, height: 140, borderRadius: 999, objectFit: "cover" }}
            alt=""
          />
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <h1
          style={{
            fontSize: 84,
            fontWeight: 600,
            color: INK,
            lineHeight: 1.05,
            letterSpacing: -2,
            margin: 0,
            maxWidth: 1000,
          }}
        >
          {heading}
        </h1>
        <p style={{ fontSize: 32, color: MUTED, margin: 0, maxWidth: 920 }}>
          {cardT("web.bookingLanding.tagline")}
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 24, color: MUTED }}>spiralclass.com</span>
        {from != null && (
          <span
            style={{
              fontSize: 30,
              fontWeight: 600,
              color: CREAM,
              background: BRAND,
              padding: "12px 28px",
              borderRadius: 999,
            }}
          >
            {cardT("web.bookingCard.fromPrice", {
              price: formatPriceForBuyer(
                from,
                cheapestTemplate?.currency ?? "MXN",
                publicFunnelLocaleFor(teacher?.bookingPageLocale),
              ),
            })}
          </span>
        )}
      </div>
    </div>,
    { ...size },
  );
}
