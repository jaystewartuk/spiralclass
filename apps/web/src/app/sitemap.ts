import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { HAS_PAYOUT_RAIL_WHERE } from "@/lib/payments/payout-rail-where";
import { EXCLUDE_TEST_ACCOUNTS_WHERE } from "@/lib/marketing/test-accounts";

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
    { url: APP_URL, changeFrequency: "weekly", priority: 1 },
    ...MARKETING_ROUTES.map((route) => ({
      url: `${APP_URL}${route.path}`,
      changeFrequency: "monthly" as const,
      priority: route.priority,
    })),
    ...teachers.map((t) => ({
      url: `${APP_URL}/b/${t.bookingSlug}`,
      lastModified: t.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
