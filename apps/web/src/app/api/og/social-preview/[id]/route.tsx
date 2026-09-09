import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import sharp from "sharp";
import {
  brandPalette,
  palette,
  SOCIAL_PREVIEW_HEIGHT,
  SOCIAL_PREVIEW_WIDTH,
} from "@spiralclass/shared";
import { isPubliclyListed } from "@/lib/marketplace-ready";
import { ogFonts } from "@/lib/og-font";
import { logger } from "@/lib/logger";
import { findSocialPreviewForCard } from "@/lib/social-preview/store";
import { socialPreviewImagePublicUrl } from "@/lib/storage/social-preview-image";

const log = logger({ surface: "social-preview" });

// The COMPOSED social card (D-123): the teacher's chosen background with every
// character of text drawn by us on top.
//
// Why this is a render-on-demand route rather than a baked PNG in object
// storage. The background is persisted (regenerating per crawl would cost money
// and be non-deterministic), but the composite is not, because Satori rendering
// is deterministic, free and already in production here — so a caption edit
// becomes instant with no re-upload, no orphaned object to sweep, and no
// second cache to invalidate. If render latency ever threatens a crawler
// timeout, baking becomes the right trade; today it isn't.
//
// Caching. The URL always carries `?v=<preview.updatedAt>` (see
// socialPreviewCardUrl), so the response is safely immutable: a changed preview
// mints a URL nothing has cached, which is the ONLY reliable way to displace
// Facebook's and WhatsApp's first-scrape caches. `v` is otherwise unused here —
// it is a cache key, not an input.
//
// Never 500. Facebook and WhatsApp treat a failed og:image fetch as "no image",
// which is a materially worse post than a plain one, so every degradation below
// falls back to a rendered card rather than an error.

export const runtime = "nodejs";

const CREAM = palette.background;
const INK = palette.text;
const BRAND = palette.primary;
const GOLD = palette.gold;

// The brand wordmark on the card. A constant, not translatable copy: it is a
// domain. (The sibling b/[slug]/opengraph-image.tsx inlines the same string and
// is baselined in the i18n guard for it; a named constant is the cleaner form
// and keeps this new file out of that baseline.)
const BRAND_DOMAIN = "spiralclass.com";

/** How long we will wait on object storage before rendering without the
 * background. Well inside a crawler's patience — a plain branded card that
 * arrives beats a perfect one that times out. */
const BACKGROUND_FETCH_TIMEOUT_MS = 3_000;

/** Safe because the caller's URL always carries ?v=<updatedAt>: the cache key
 * changes whenever the content does, so a year-long immutable cache can never
 * serve a stale card. */
const CARD_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * WhatsApp fetches an og:image to build its in-chat thumbnail and gives up on
 * one much past ~300 KB, showing a bare text link instead. Satori/resvg only
 * emit PNG, and a PNG of a photographic AI background is enormous: the two
 * cards live in production on 2026-08-26 measured 921 KB and 1.45 MB, against
 * 93 KB for the text-and-flat-colour card in b/[slug]/opengraph-image.tsx. So
 * the composite is re-encoded to JPEG before it leaves — the one format choice
 * that turns a photograph into something a chat app will render.
 */
const JPEG_TARGET_BYTES = 300_000;
const JPEG_QUALITY = 80;
/** Only if quality 80 still overshoots — a very busy background. Visibly
 * softer, and still far better than no preview at all. */
const JPEG_QUALITY_FALLBACK = 60;

/**
 * Re-encode the rendered card as JPEG, or hand back the PNG untouched.
 *
 * Best-effort by design, like every other degradation on this route: a crawler
 * reads a failed og:image as "no image", so a heavy card that renders always
 * beats a light one that 500s.
 */
async function asJpeg(rendered: Response): Promise<Response> {
  try {
    const png = Buffer.from(await rendered.arrayBuffer());
    let out = await sharp(png).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    if (out.byteLength > JPEG_TARGET_BYTES) {
      out = await sharp(png).jpeg({ quality: JPEG_QUALITY_FALLBACK }).toBuffer();
    }
    return new Response(new Uint8Array(out), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": CARD_CACHE_CONTROL },
    });
  } catch (err) {
    // error(), not warn(): this forwards to Sentry, and a re-encode that starts
    // failing everywhere (a missing libvips on a new base image, say) is
    // otherwise invisible — the cards keep rendering, just too heavy for the
    // chat clients they are mostly shared into.
    log.error("jpeg re-encode failed; serving png", err);
    return rendered;
  }
}

/** Fetch the background as a data URL. Satori cannot fetch remote images
 * itself, and inlining means a storage hiccup degrades to "no background"
 * instead of a broken render. Best-effort by design — same approach the
 * existing b/[slug]/opengraph-image.tsx takes with the teacher avatar. */
async function backgroundDataUrl(storagePath: string): Promise<string | null> {
  const url = socialPreviewImagePublicUrl(storagePath);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(BACKGROUND_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/png";
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // A uuid check before the query: this is an unauthenticated public route, so
  // it should cost nothing to probe with garbage.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  }

  let row: Awaited<ReturnType<typeof findSocialPreviewForCard>> = null;
  try {
    row = await findSocialPreviewForCard(id);
  } catch (err) {
    log.error("card lookup failed", err);
  }

  // Same listing gate as the booking page, its OG card and the sitemap: a
  // disabled or not-yet-Marketplace-Ready teacher's name must not leak out of a
  // social card either. A 404 here is safe precisely because generateMetadata
  // only ever emits this URL when the preview resolves — so reaching a 404 means
  // the preview was removed between the scrape and the fetch, and the crawler
  // simply falls back to no image.
  if (!row || !isPubliclyListed(row.teacher)) {
    return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  }

  const background = await backgroundDataUrl(row.image.storagePath);
  const caption = row.caption.trim();

  const rendered = new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        // The fallback ground when the background can't be fetched: brand
        // colours, never a white void.
        // Satori cannot read CSS custom properties, so these are literal values —
        // but they are palette VALUES, not hand-picked ones. The gradient end was
        // `#8E3522`, a dark terracotta from the pre-D-140 brand, so the card
        // graded from the new indigo into an unrelated brown.
        background: `linear-gradient(135deg, ${BRAND} 0%, ${brandPalette.ink} 100%)`,
      }}
    >
      {background && (
        /* Satori renders this element itself: next/image is a browser React
           component and produces nothing here. The sibling
           b/[slug]/opengraph-image.tsx uses a raw <img> for the same reason —
           the rule simply doesn't fire on Next's metadata-convention filenames. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={background}
          width={SOCIAL_PREVIEW_WIDTH}
          height={SOCIAL_PREVIEW_HEIGHT}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            // cover, not contain: the provider's aspect ratio only
            // approximates 1.91:1, and an uploaded image can be any shape.
            // Filling the canvas and cropping beats letterboxing a social
            // card with bars.
            objectFit: "cover",
          }}
          alt=""
        />
      )}

      {/* Legibility scrim. Text over an arbitrary photograph is unreadable
            often enough that this has to be unconditional — a caption that
            disappears into a bright sky is the failure mode that would make
            teachers stop using the feature. */}
      {caption.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.28) 45%, rgba(0,0,0,0.72) 100%)",
          }}
        />
      )}

      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 64px",
        }}
      >
        {/* Caption, vertically centred and horizontally inset. WhatsApp
              renders a near-square centre crop as its in-chat thumbnail, so
              anything hugging an edge is simply gone there — the caption gets
              the safe middle and the brand footer takes the expendable bottom. */}
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
          {caption.length > 0 && (
            <p
              style={{
                display: "flex",
                margin: 0,
                maxWidth: 880,
                textAlign: "center",
                // Steps down once for long captions so a two-line caption and
                // a four-line one both fit the band rather than overflowing.
                fontSize: caption.length > 60 ? 56 : 72,
                lineHeight: 1.15,
                fontWeight: 700,
                letterSpacing: -1,
                color: "#FFFFFF",
                // Belt and braces with the scrim: a hard shadow keeps the
                // text readable over a blown-out highlight the gradient
                // doesn't fully tame.
                textShadow: "0 4px 24px rgba(0,0,0,0.65)",
              }}
            >
              {caption}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="44" height="44" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
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
              <circle cx="32.5" cy="32" r="2" fill={GOLD} />
            </svg>
            {/* Rendered by us, so it is always spelled correctly — the whole
                  reason the image model is forbidden from producing text. */}
            <span
              style={{
                fontSize: 30,
                fontWeight: 600,
                color: "#FFFFFF",
                textShadow: "0 2px 12px rgba(0,0,0,0.7)",
              }}
            >
              {row.teacher.name}
            </span>
          </div>
          <span
            style={{
              fontSize: 24,
              fontWeight: 600,
              color: INK,
              background: CREAM,
              padding: "10px 22px",
              borderRadius: 999,
            }}
          >
            {BRAND_DOMAIN}
          </span>
        </div>
      </div>
    </div>,
    {
      width: SOCIAL_PREVIEW_WIDTH,
      height: SOCIAL_PREVIEW_HEIGHT,
      // Without this Satori falls back to its default serif — see lib/og-font.ts.
      fonts: ogFonts(),
      headers: { "Cache-Control": CARD_CACHE_CONTROL },
    },
  );

  return asJpeg(rendered);
}
