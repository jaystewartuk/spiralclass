import { beforeEach, describe, expect, it, vi } from "vitest";

// Resolution is the load-bearing half of D-123: it decides which image (if
// any) a given shared link previews with, and its FALLBACK is what guarantees
// every link shared before this feature existed behaves exactly as it did.

const socialPreviewFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { socialPreview: { findMany: socialPreviewFindMany } },
}));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com" }),
}));
vi.mock("@/lib/storage/social-preview-image", () => ({
  socialPreviewImagePublicUrl: (path: string | null) =>
    path ? `https://cdn.example/${path}` : null,
}));

const GROUP_A = { id: "a1b2c3d4-0000-0000-0000-000000000000", name: "Expats CDMX" };
const GROUP_B = { id: "f9e8d7c6-0000-0000-0000-000000000000", name: "Mamás de Polanco" };

function row(over: Record<string, unknown> = {}) {
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

// resolveSocialPreview is wrapped in React.cache, which memoizes per request —
// so each case imports a fresh module instance rather than sharing a cache.
async function resolve(utmContent: string | null) {
  vi.resetModules();
  const { resolveSocialPreview } = await import("@/lib/social-preview/store");
  return resolveSocialPreview("teacher-1", utmContent);
}

beforeEach(() => {
  socialPreviewFindMany.mockReset();
});

describe("resolveSocialPreview", () => {
  it("returns null when the teacher has configured nothing — the whole back-compat story", async () => {
    // The caller then emits no openGraph.images, Next's file-convention
    // opengraph-image.tsx supplies today's card, and the metadata is
    // byte-identical to what it was before this feature shipped.
    socialPreviewFindMany.mockResolvedValue([]);
    expect(await resolve("expats-cdmx-a1b2")).toBeNull();
  });

  it("picks the group named by utm_content", async () => {
    socialPreviewFindMany.mockResolvedValue([
      row({ id: "default", shareGroupId: null, image: { angle: "promo", source: "upload" } }),
      row({ id: "group-a", shareGroupId: GROUP_A.id, shareGroup: GROUP_A }),
    ]);
    const resolved = await resolve("expats-cdmx-a1b2");
    expect(resolved?.id).toBe("group-a");
    expect(resolved?.angle).toBe("meme");
  });

  it("falls back to the teacher's default for an UNTAGGED share", async () => {
    socialPreviewFindMany.mockResolvedValue([
      row({ id: "default", shareGroupId: null }),
      row({ id: "group-a", shareGroupId: GROUP_A.id, shareGroup: GROUP_A }),
    ]);
    expect((await resolve(null))?.id).toBe("default");
  });

  it("falls back to the default when utm_content names a group with no preview", async () => {
    socialPreviewFindMany.mockResolvedValue([row({ id: "default", shareGroupId: null })]);
    expect((await resolve("some-other-group-9999"))?.id).toBe("default");
  });

  it("returns null when a tagged link's group has no preview AND there is no default", async () => {
    // Configuring group A must not silently give group B a preview it never
    // chose — B keeps the standard card.
    socialPreviewFindMany.mockResolvedValue([
      row({ id: "group-a", shareGroupId: GROUP_A.id, shareGroup: GROUP_A }),
    ]);
    expect(await resolve("mamas-de-polanco-f9e8")).toBeNull();
  });

  it("still resolves after the group was RENAMED", async () => {
    // Links carrying the old slug are already posted in that group and keep
    // being crawled; matching the stable 4-hex id suffix is what stops a
    // rename orphaning them.
    socialPreviewFindMany.mockResolvedValue([
      row({ id: "group-a", shareGroupId: GROUP_A.id, shareGroup: GROUP_A }),
    ]);
    expect((await resolve("whatever-she-called-it-before-a1b2"))?.id).toBe("group-a");
  });

  it("cache-busts the card URL on the placement's updatedAt", async () => {
    // Facebook and WhatsApp cache the first scrape of a URL; a changed preview
    // has to mint a URL they have never seen or the old card sticks.
    socialPreviewFindMany.mockResolvedValue([row({ id: "default", shareGroupId: null })]);
    const resolved = await resolve(null);
    expect(resolved?.cardUrl).toBe(
      `https://spiralclass.com/api/og/social-preview/default?v=${new Date("2026-08-01T00:00:00Z").getTime()}`,
    );
  });

  it("reports the group's CANONICAL tag, so og:url can round-trip to this same preview", async () => {
    socialPreviewFindMany.mockResolvedValue([
      row({ id: "group-a", shareGroupId: GROUP_A.id, shareGroup: GROUP_A }),
    ]);
    expect((await resolve("expats-cdmx-a1b2"))?.shareGroupSlug).toBe("expats-cdmx-a1b2");
  });

  it("normalizes a STALE tag to the group's current one", async () => {
    // The rename-tolerant suffix match above accepts the old slug. Echoing it
    // back into og:url would mint a second Facebook object for one group, so
    // the canonical slug is what comes out.
    socialPreviewFindMany.mockResolvedValue([
      row({ id: "group-a", shareGroupId: GROUP_A.id, shareGroup: GROUP_A }),
    ]);
    expect((await resolve("whatever-she-called-it-before-a1b2"))?.shareGroupSlug).toBe(
      "expats-cdmx-a1b2",
    );
  });

  it("reports NO tag for the teacher's default preview", async () => {
    // The default is what an untagged link resolves to, so its og:url must stay
    // undecorated — otherwise every share consolidates onto an arbitrary tag.
    socialPreviewFindMany.mockResolvedValue([row({ id: "default", shareGroupId: null })]);
    expect((await resolve(null))?.shareGroupSlug).toBeNull();
    expect((await resolve("some-other-group-9999"))?.shareGroupSlug).toBeNull();
  });

  it("issues exactly one query", async () => {
    socialPreviewFindMany.mockResolvedValue([]);
    await resolve("expats-cdmx-a1b2");
    // /b/[slug] is the app's primary acquisition surface — the resolver is
    // allowed one cheap indexed read there, not a join per group.
    expect(socialPreviewFindMany).toHaveBeenCalledTimes(1);
  });
});
