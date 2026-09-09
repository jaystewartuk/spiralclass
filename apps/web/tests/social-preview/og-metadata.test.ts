import { beforeEach, describe, expect, it, vi } from "vitest";

// The seam that makes this feature safe: Next merges the file-convention
// opengraph-image.tsx into a page's metadata ONLY when generateMetadata did not
// return an own `openGraph.images` property
// (next/dist/lib/metadata/resolve-metadata.js, mergeStaticMetadata). So
// OMITTING the key leaves today's card in place byte for byte, and SETTING it
// overrides cleanly.
//
// These tests pin both halves at the generateMetadata boundary. The Next-side
// merge itself is framework behaviour, verified by reading that source rather
// than re-implemented here.

const teacherFindUnique = vi.fn();
const socialPreviewFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: teacherFindUnique },
    student: { findFirst: vi.fn() },
    socialPreview: { findMany: socialPreviewFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => null),
  getCurrentStudent: vi.fn(async () => null),
  getCurrentTeacher: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/server", () => ({ auth: {} }));
vi.mock("@/lib/env", () => ({
  hasStripeCreds: () => true,
  isSuperuser: () => false,
  isProductionDeployment: () => true,
  serverEnv: () => ({ SESSION_SECRET: "s", APP_URL: "https://spiralclass.com" }),
}));
vi.mock("@/lib/wise", () => ({ isWiseReady: () => false, buildWisePayUrl: () => "" }));
vi.mock("@/lib/booking/slot-inputs", () => ({ loadSlotInputs: vi.fn() }));
vi.mock("@/lib/subscriptions/service", () => ({
  getFoundingCohortState: vi.fn(async () => ({ isOpen: false })),
}));
vi.mock("@/lib/storage/social-preview-image", () => ({
  socialPreviewImagePublicUrl: (p: string | null) => (p ? `https://cdn.example/${p}` : null),
}));

const PUBLISHED_TEACHER = {
  id: "t1",
  name: "Alicia Moreno",
  headline: "Clases de español con confianza",
  bio: "Profesora certificada.",
  photoPath: "t1",
  updatedAt: new Date("2026-01-01"),
  timezone: "America/Mexico_City",
  onboardingCompleteAt: new Date("2026-01-01"),
  disabledAt: null,
  stripeAccountId: "acct_1",
  stripeChargesEnabled: true,
  wisePaymentsEnabled: false,
  wiseHandle: null,
  templatesTouchedAt: new Date("2026-01-01"),
  availabilityTouchedAt: new Date("2026-01-01"),
  packageTemplates: [{ priceMinorUnits: 150_000 }],
  testimonials: [],
};

const GROUP = { id: "a1b2c3d4-0000-0000-0000-000000000000", name: "Expats CDMX" };

function previewRow(over: Record<string, unknown> = {}) {
  return {
    id: "preview-1",
    shareGroupId: null,
    caption: "hola",
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    shareGroup: null,
    image: { angle: "meme", source: "ai" },
    ...over,
  };
}

async function metadataFor(search: Record<string, string> = {}) {
  // React.cache memoizes the resolver per request; a fresh module per case
  // keeps the cases independent.
  vi.resetModules();
  const { generateMetadata } = await import("@/app/b/[slug]/page");
  return generateMetadata({
    params: Promise.resolve({ slug: "mira" }),
    searchParams: Promise.resolve(search),
  });
}

beforeEach(() => {
  teacherFindUnique.mockReset().mockResolvedValue(PUBLISHED_TEACHER);
  socialPreviewFindMany.mockReset().mockResolvedValue([]);
});

describe("booking-page og:image", () => {
  it("EXISTING LINKS: omits openGraph.images entirely when nothing is configured", async () => {
    // The single most important assertion in this feature. `undefined`, not an
    // empty array: an empty array would suppress the file-convention card too,
    // silently stripping the preview from every link already in the wild.
    const meta = await metadataFor();
    expect(meta.openGraph && "images" in meta.openGraph).toBe(false);
    expect(meta.twitter && "images" in meta.twitter).toBe(false);
  });

  it("EXISTING LINKS: still omits it for a TAGGED link when that group has no preview", async () => {
    socialPreviewFindMany.mockResolvedValue([]);
    const meta = await metadataFor({ utm_content: "expats-cdmx-a1b2" });
    expect(meta.openGraph && "images" in meta.openGraph).toBe(false);
  });

  it("overrides og:image and twitter:image once a default preview exists", async () => {
    socialPreviewFindMany.mockResolvedValue([previewRow()]);
    const meta = await metadataFor();
    const expected = `https://spiralclass.com/api/og/social-preview/preview-1?v=${new Date("2026-08-01T00:00:00Z").getTime()}`;
    expect(meta.openGraph?.images).toEqual([{ url: expected, width: 1200, height: 630 }]);
    expect(meta.twitter?.images).toEqual([{ url: expected, width: 1200, height: 630 }]);
  });

  it("uses the GROUP's preview for a link tagged to that group", async () => {
    socialPreviewFindMany.mockResolvedValue([
      previewRow({ id: "default", shareGroupId: null }),
      previewRow({ id: "group-a", shareGroupId: GROUP.id, shareGroup: GROUP }),
    ]);
    const meta = await metadataFor({ utm_content: "expats-cdmx-a1b2" });
    expect(JSON.stringify(meta.openGraph?.images)).toContain("/social-preview/group-a?v=");
  });

  it("puts the group tag on og:url, or Facebook never sees the group's card", async () => {
    // Facebook treats og:url as the object's canonical and re-scrapes it when
    // it differs from the link that was shared. An undecorated og:url therefore
    // sent it back to the untagged page — which resolves no group preview — and
    // the group's card was fetched and then thrown away. Verified against
    // production and against Facebook's own Sharing Debugger on 2026-08-26.
    socialPreviewFindMany.mockResolvedValue([
      previewRow({ id: "group-a", shareGroupId: GROUP.id, shareGroup: GROUP }),
    ]);
    const meta = await metadataFor({ utm_content: "expats-cdmx-a1b2" });
    expect(meta.openGraph?.url).toBe("/b/mira?utm_content=expats-cdmx-a1b2");
    // Search still indexes exactly one booking page per teacher.
    expect(meta.alternates?.canonical).toBe("/b/mira");
  });

  it("og:url is a FIXPOINT — scraping it resolves the same group again", async () => {
    // The property that stops Facebook's re-scrape from looping: the URL og:url
    // names must itself emit that same og:url.
    socialPreviewFindMany.mockResolvedValue([
      previewRow({ id: "group-a", shareGroupId: GROUP.id, shareGroup: GROUP }),
    ]);
    const first = await metadataFor({ utm_content: "expats-cdmx-a1b2" });
    const second = await metadataFor({ utm_content: "expats-cdmx-a1b2" });
    expect(second.openGraph?.url).toBe(first.openGraph?.url);
    expect(JSON.stringify(second.openGraph?.images)).toContain("/social-preview/group-a?v=");
  });

  it("normalizes a stale tag rather than echoing it back", async () => {
    socialPreviewFindMany.mockResolvedValue([
      previewRow({ id: "group-a", shareGroupId: GROUP.id, shareGroup: GROUP }),
    ]);
    const meta = await metadataFor({ utm_content: "old-name-a1b2" });
    expect(meta.openGraph?.url).toBe("/b/mira?utm_content=expats-cdmx-a1b2");
  });

  it("leaves og:url UNDECORATED for the default preview and for no preview at all", async () => {
    // Both resolve the same card for tagged and untagged links alike, so
    // decorating og:url would only split one teacher's shares across several
    // Facebook objects for nothing.
    socialPreviewFindMany.mockResolvedValue([previewRow({ id: "default", shareGroupId: null })]);
    expect((await metadataFor({ utm_content: "expats-cdmx-a1b2" })).openGraph?.url).toBe("/b/mira");

    socialPreviewFindMany.mockResolvedValue([]);
    expect((await metadataFor({ utm_content: "expats-cdmx-a1b2" })).openGraph?.url).toBe("/b/mira");
    expect((await metadataFor()).openGraph?.url).toBe("/b/mira");
  });

  it("does not resolve a preview at all for a teacher whose page 404s", async () => {
    // A not-yet-Marketplace-Ready teacher's card must not leak, and we
    // shouldn't pay for the query either.
    teacherFindUnique.mockResolvedValue({ ...PUBLISHED_TEACHER, disabledAt: new Date() });
    const meta = await metadataFor();
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(socialPreviewFindMany).not.toHaveBeenCalled();
  });

  it("ignores a repeated utm_content (an array), rather than guessing", async () => {
    socialPreviewFindMany.mockResolvedValue([
      previewRow({ id: "group-a", shareGroupId: GROUP.id, shareGroup: GROUP }),
    ]);
    // ?utm_content=a&utm_content=b arrives as an array; treated as untagged, so
    // it falls through to the default (here: none) rather than picking one.
    const meta = await metadataFor({ utm_content: ["x", "y"] as unknown as string });
    expect(meta.openGraph && "images" in meta.openGraph).toBe(false);
  });

  it("leaves title, description and canonical untouched", async () => {
    socialPreviewFindMany.mockResolvedValue([previewRow()]);
    const meta = await metadataFor();
    expect(meta.title).toBe("Clases de español con confianza");
    expect(meta.alternates?.canonical).toBe("/b/mira");
    expect(meta.openGraph?.locale).toBe("en_US");
  });
});
