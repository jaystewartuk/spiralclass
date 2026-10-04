import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { HAS_PAYOUT_RAIL_WHERE } from "@/lib/payments/payout-rail-where";
import { EXCLUDE_TEST_ACCOUNTS_WHERE } from "@/lib/marketing/test-accounts";
import { pageLanguages } from "@/lib/seo/localized-alternates";
import { DEFAULT_LOCALE, localizedPath, type AppLocale } from "@spiralclass/shared";

const APP_URL = (process.env.APP_URL ?? "https://spiralclass.com").replace(/\/$/, "");

// Served live rather than baked at build: a teacher who publishes after a
// deploy must show up without waiting for the next build, and the build
// itself must not need a database (same hazard /pricing avoids).
export const dynamic = "force-dynamic";

// The static public marketing/legal pages. Utility and auth surfaces
// (/sign-in, /m, /r, checkout pages) are deliberately absent —
// see robots.ts and the per-page noindex metadata.
const MARKETING_ROUTES = [
  { path: "/pricing", priority: 0.9 },
  { path: "/features", priority: 0.9 },
  { path: "/about", priority: 0.7 },
  { path: "/help", priority: 0.7 },
  { path: "/terms", priority: 0.3 },
  { path: "/privacy-notice", priority: 0.3 },
] as const;

// Lists the public pages so search engines can discover each teacher's
// /b/<slug> plus the marketing surface. Only Marketplace Ready, non-disabled
// teachers are included — a DB-level translation of isPubliclyListed()
// (lib/marketplace-ready.ts), which the page/buy-page 404 logic uses directly;
// a plain JS predicate can't run inside a Prisma `where`, so this must be kept
// in sync with that function by hand.
// One entry per URL a public page has (D-193), each carrying the page's whole
// hreflang set — the same set its metadata emits (localizedAlternates), so the
// sitemap and the page cannot tell a search engine two different things. A
// page is listed only in the languages its content exists in.
function localizedEntries(
  path: string,
  changeFrequency: "weekly" | "monthly",
  priority: number,
): MetadataRoute.Sitemap {
  const languages = pageLanguages(path);
  // The bare root is listed as APP_URL itself, with no trailing slash, as it
  // always has been.
  const absolute = (locale: AppLocale) => {
    const localized = localizedPath(path, locale);
    return localized === "/" ? APP_URL : `${APP_URL}${localized}`;
  };
  const alternates = {
    languages: {
      ...Object.fromEntries(languages.map((l) => [l, absolute(l)])),
      "x-default": absolute(DEFAULT_LOCALE),
    },
  };
  return languages.map((locale) => ({
    url: absolute(locale),
    changeFrequency,
    priority,
    alternates,
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const teachers = await prisma.teacher.findMany({
    where: {
      onboardingCompleteAt: { not: null },
      disabledAt: null,
      photoPath: { not: null },
      bio: { not: null },
      templatesTouchedAt: { not: null },
      availabilityTouchedAt: { not: null },
      ...HAS_PAYOUT_RAIL_WHERE,
      // Fixtures pass every publicly-listed check, because they were built to.
      // Filtered in SQL so no address is selected — see marketing/test-accounts.ts.
      ...EXCLUDE_TEST_ACCOUNTS_WHERE,
    },
    select: { bookingSlug: true, updatedAt: true },
  });

  return [
    ...localizedEntries("/", "weekly", 1),
    ...MARKETING_ROUTES.flatMap((route) => localizedEntries(route.path, "monthly", route.priority)),
    ...teachers.map((t) => ({
      url: `${APP_URL}/b/${t.bookingSlug}`,
      lastModified: t.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
