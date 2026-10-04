import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The site-wide social card, one URL per language (D-193). It was the file
// convention app/opengraph-image.tsx, one URL for every language, which a
// crawler fetched with no cookie and no Accept-Language — so `/es/pricing`
// previewed as an English card under a Spanish title.

const requestHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));
vi.mock("@/lib/env", () => ({ hasStripeCreds: () => true }));
// The root layout's body reads these; its metadata does not.
vi.mock("@/lib/reading-server", () => ({ getReadingPreferences: vi.fn() }));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "" });
  return { Atkinson_Hyperlegible: font, JetBrains_Mono: font };
});

const { GET } = await import("@/app/social-card/[locale]/route");

async function card(locale: string) {
  return GET(new Request(`https://spiralclass.com/social-card/${locale}`), {
    params: Promise.resolve({ locale }),
  });
}

beforeEach(() => requestHeaders.clear());

describe("the social card route", () => {
  it("renders a PNG per language, and a different one for each", async () => {
    const es = await card("es");
    const fr = await card("fr");
    expect(es.status).toBe(200);
    expect(es.headers.get("content-type")).toBe("image/png");
    const [esBytes, frBytes] = await Promise.all([es.arrayBuffer(), fr.arrayBuffer()]);
    expect(Buffer.from(esBytes).equals(Buffer.from(frBytes))).toBe(false);
  });

  // Next's ImageResponse defaults to a year-long `immutable` cache, which is
  // safe only on a URL carrying a content hash. This one has none, so a CDN
  // would pin the first card it saw for good.
  it("is never cached as immutable", async () => {
    const res = await card("en");
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).not.toContain("immutable");
    expect(cacheControl).toContain("max-age=86400");
  });

  it("is a 404 for a language that is not registered", async () => {
    expect((await card("klingon")).status).toBe(404);
  });
});

describe("pages name the card in their own language", () => {
  it("the root layout gives every page its language's card", async () => {
    requestHeaders.set("x-locale", "es");
    const { generateMetadata } = await import("@/app/layout");
    const meta = await generateMetadata();
    expect(meta.openGraph?.images).toEqual([
      expect.objectContaining({ url: "/social-card/es", width: 1200, height: 630 }),
    ]);
    expect(meta.twitter?.images).toEqual([expect.objectContaining({ url: "/social-card/es" })]);
  });

  // /help sets its own openGraph, which replaces the layout's whole object.
  it("the help page, which replaces the layout's openGraph, keeps a card and its own URL", async () => {
    requestHeaders.set("x-locale", "fr");
    const { generateMetadata } = await import("@/app/help/page");
    const meta = await generateMetadata();
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: "/social-card/fr" })]);
    expect(meta.openGraph?.url).toBe("/fr/help");
  });
});
