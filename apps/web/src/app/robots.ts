import type { MetadataRoute } from "next";
import { isProductionDeployment } from "@/lib/env";

const APP_URL = (process.env.APP_URL ?? "https://spiralclass.com").replace(/\/$/, "");

// Let crawlers index the public marketing + booking pages, but keep
// authenticated/operational surfaces out of the index.
//
// Mechanics note: a robots.txt disallow blocks CRAWLING, not indexing — a
// disallowed URL that other pages link to can still be indexed reference-less,
// and Google can never see a noindex on a page it isn't allowed to fetch. So
// paths linked from public pages that must stay out of the index (/sign-in,
// /sign-up, /b/*/buy*) are handled with per-page
// `robots: { index: false }` metadata instead of a disallow here; this list is
// crawl-budget hygiene for auth-gated and email-token surfaces only.
export default function robots(): MetadataRoute.Robots {
  // Preview (preview.spiralclass.com is a custom domain, so Vercel's automatic
  // *.vercel.app noindex does NOT cover it) must never enter the index as a
  // duplicate of production. It stays CRAWLABLE on purpose: preview shipped
  // with no indexing protection at all (D-26 onward), so pages may already be
  // indexed, and Google's only clean removal path is fetching them and seeing
  // the X-Robots-Tag noindex that next.config.ts adds on non-prod deploys —
  // a disallow here would block that forever. No sitemap is advertised.
  if (!isProductionDeployment()) {
    return { rules: { userAgent: "*", allow: "/" } };
  }
  // `userAgent: "*"` deliberately includes GPTBot, ClaudeBot, PerplexityBot and
  // every other AI/LLM crawler — this is a decision, not an oversight
  // (booking-page-ai-readability).
  //
  // ⚠️ Corrected 2026-08-28. This comment used to justify that decision by
  // saying PostHog showed crawlers as "effectively ALL" of /b/<slug>'s traffic,
  // read off `$virt_bot_name` / `$virt_is_bot` on `booking_page_viewed`. That
  // reading was wrong: the event ships from posthog-node with no visitor user
  // agent attached, so `$virt_is_bot` is true on 100% of it and describes our
  // own server, not the caller. Do not re-derive a traffic claim from those
  // virtual properties — use the `isBot` property the page now sends, which is
  // our own classification of the real request agent
  // (lib/marketing/bots.ts).
  //
  // What the corrected numbers say, over /b/alicia-moreno's 30 days to 2026-08-28:
  // 765 server-rendered requests, but 79 client-side `$pageview`s from 28
  // distinct people. So crawlers really are most of the volume — roughly nine
  // requests in ten — but they are NOT all of it, and the human tenth is the
  // part that can buy. The decision to keep them allowed stands on its own
  // merit (crawling costs us little, and an assistant referral is plausible
  // upside), not on the "only channel bringing traffic" claim, which was an
  // artifact.
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/admin",
        "/api/",
        "/my-classes",
        "/onboarding",
        "/settings",
        "/payments",
        "/notifications",
        "/auth/",
        "/m/",
        "/r/",
      ],
    },
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
