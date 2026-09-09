// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import sharp from "sharp";

(globalThis as Record<string, unknown>).React = React;

// Renders the card for REAL — no next/og mock — and asserts actual PNG bytes
// come out. card-route.test.ts pins the route's policy (gating, caching,
// degradation) with ImageResponse stubbed; this pins the thing that stub hides:
// that the JSX we hand Satori is layout it can actually rasterise.
//
// Satori is strict in ways ordinary React is not — every child of a multi-child
// element needs an explicit `display`, unsupported CSS throws rather than being
// ignored — so a layout mistake here is a runtime 500 on a public URL that only
// a real render catches.

const findSocialPreviewForCard = vi.fn();
vi.mock("@/lib/social-preview/store", () => ({ findSocialPreviewForCard }));
// Null by default — no public bucket in tests, and the background-less path is
// the degraded one we most want rasterising cleanly. The weight test below
// points it at a stubbed bucket, because a card's size is decided almost
// entirely by the photograph underneath it.
let backgroundUrl: string | null = null;
vi.mock("@/lib/storage/social-preview-image", () => ({
  socialPreviewImagePublicUrl: () => backgroundUrl,
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const ID = "11111111-1111-1111-1111-111111111111";

const TEACHER = {
  name: "Alicia Moreno",
  bio: "Profesora certificada.",
  photoPath: "t1",
  onboardingCompleteAt: new Date("2026-01-01"),
  disabledAt: null,
  templatesTouchedAt: new Date("2026-01-01"),
  availabilityTouchedAt: new Date("2026-01-01"),
  stripeChargesEnabled: true,
  wisePaymentsEnabled: false,
  wiseHandle: null,
};

async function render(caption: string): Promise<Buffer> {
  findSocialPreviewForCard.mockResolvedValue({
    caption,
    image: { storagePath: "t1/social/img-1.png", angle: "meme" },
    teacher: TEACHER,
  });
  const { GET } = await import("@/app/api/og/social-preview/[id]/route");
  const res = await GET(new Request(`https://spiralclass.com/api/og/social-preview/${ID}`), {
    params: Promise.resolve({ id: ID }),
  });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** The JPEG start-of-image marker. Satori rasterises to PNG; the route
 * re-encodes before serving, so what a crawler receives is JPEG. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

async function imageSize(buf: Buffer) {
  const { width, height, format } = await sharp(buf).metadata();
  return { width, height, format };
}

beforeEach(() => {
  backgroundUrl = null;
  vi.unstubAllGlobals();
});

describe("social card — real Satori render", () => {
  it("rasterises to a real 1200x630 image", async () => {
    const card = await render("Cuando tu amigo mexicano habla muy rápido...");
    expect(card.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    expect(await imageSize(card)).toEqual({ width: 1200, height: 630, format: "jpeg" });
  }, 30_000);

  it("renders an accented Spanish caption — the case the model is forbidden from drawing", async () => {
    // The whole composition strategy rests on us drawing this text, so it has
    // to survive the font stack: ñ, á, í, ¿, ¡.
    const card = await render("¿Por qué mi español no mejora? ¡Ñ, á, í!");
    expect(card.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    expect(card.byteLength).toBeGreaterThan(1000);
  }, 30_000);

  it("renders with NO caption (image-only) without collapsing the layout", async () => {
    const card = await render("");
    expect(await imageSize(card)).toMatchObject({ width: 1200, height: 630 });
  }, 30_000);

  it("renders a maximum-length caption without throwing", async () => {
    // 120 chars is the enforced ceiling; the font steps down once past 60.
    const card = await render("x".repeat(120));
    expect(await imageSize(card)).toMatchObject({ width: 1200, height: 630 });
  }, 30_000);

  it("stays under a chat client's preview ceiling WITH a photographic background", async () => {
    // The case that actually broke in production on 2026-08-26, and the reason
    // this test now stubs the bucket: with no background the composite is flat
    // colour and a few tens of KB, so the old PNG-only route sailed past a size
    // guard while serving 921 KB and 1.45 MB cards to real crawlers. Gaussian
    // noise is the worst case a photograph can approach — it is what a lossless
    // PNG cannot compress and a JPEG can.
    const background = await sharp({
      create: {
        width: 1200,
        height: 630,
        channels: 3,
        background: "#000000",
        noise: { type: "gaussian", mean: 128, sigma: 60 },
      },
    })
      .png()
      .toBuffer();
    // Sanity: the very thing the route must not hand a crawler.
    expect(background.byteLength).toBeGreaterThan(500_000);

    backgroundUrl = "https://cdn.example/t1/social/img-1.png";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(background), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    const card = await render("Cuando tu amigo mexicano habla muy rápido...");
    expect(card.byteLength).toBeLessThan(300_000);
  }, 30_000);
});
