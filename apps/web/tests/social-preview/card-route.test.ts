import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

// The route compiles with the classic JSX runtime under vitest (tsconfig sets
// jsx: "preserve"), so React has to be in scope — same shim the component
// tests use (tests/components/booking-status-badge.test.ts).
(globalThis as Record<string, unknown>).React = React;

// The composed-card route. Three properties are pinned, all of which a crawler
// depends on:
//   * it applies the SAME listing gate as the booking page (no leaking a
//     not-yet-published teacher's name into a social card);
//   * it is safely cacheable forever, because the caller's URL carries ?v=;
//   * it never fails on a background-fetch problem — Facebook and WhatsApp read
//     a failed og:image as "no image", which is worse than a plain card.

const findSocialPreviewForCard = vi.fn();
const imageResponseCalls: { element: unknown; opts: Record<string, unknown> }[] = [];

vi.mock("@/lib/social-preview/store", () => ({ findSocialPreviewForCard }));
vi.mock("@/lib/storage/social-preview-image", () => ({
  socialPreviewImagePublicUrl: (p: string | null) => (p ? `https://cdn.example/${p}` : null),
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock("next/og", () => ({
  // Satori itself is Next's to test; we assert what we hand it. A real Response
  // subclass with a body, because the route reads it back to re-encode.
  ImageResponse: class extends Response {
    constructor(element: unknown, opts: Record<string, unknown>) {
      super(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: (opts?.headers as Record<string, string>) ?? {},
      });
      imageResponseCalls.push({ element, opts });
    }
  },
}));

// sharp does the re-encode; what matters here is that the route asks for JPEG,
// notices when the result is still too heavy for WhatsApp, and never lets an
// encoder failure reach a crawler as an error.
const toBuffer = vi.fn();
const sharpJpeg = vi.fn(() => ({ toBuffer }));
const sharpFn = vi.fn(() => ({ jpeg: sharpJpeg }));
vi.mock("sharp", () => ({ default: sharpFn }));

const PUBLISHED = {
  caption: "Cuando tu amigo mexicano habla muy rápido...",
  image: { storagePath: "t1/social/img-1.png", angle: "meme" },
  teacher: {
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
  },
};

const ID = "11111111-1111-1111-1111-111111111111";

async function get(id = ID) {
  vi.resetModules();
  const { GET } = await import("@/app/api/og/social-preview/[id]/route");
  return GET(new Request(`https://spiralclass.com/api/og/social-preview/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  imageResponseCalls.length = 0;
  findSocialPreviewForCard.mockResolvedValue(PUBLISHED);
  sharpFn.mockImplementation(() => ({ jpeg: sharpJpeg }));
  sharpJpeg.mockImplementation(() => ({ toBuffer }));
  toBuffer.mockResolvedValue(Buffer.alloc(120_000));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    ),
  );
});

describe("GET /api/og/social-preview/[id]", () => {
  it("renders the canonical 1200x630 card, immutably cacheable", async () => {
    const res = await get();
    expect(imageResponseCalls).toHaveLength(1);
    expect(imageResponseCalls[0].opts.width).toBe(1200);
    expect(imageResponseCalls[0].opts.height).toBe(630);
    // Safe only because socialPreviewCardUrl always appends ?v=<updatedAt>.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("404s a non-uuid without ever hitting the database", async () => {
    const res = await get("../../etc/passwd");
    expect(res.status).toBe(404);
    expect(findSocialPreviewForCard).not.toHaveBeenCalled();
  });

  it("404s an unknown preview", async () => {
    findSocialPreviewForCard.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("404s for a teacher who is not publicly listed", async () => {
    findSocialPreviewForCard.mockResolvedValue({
      ...PUBLISHED,
      teacher: { ...PUBLISHED.teacher, disabledAt: new Date("2026-06-01") },
    });
    expect((await get()).status).toBe(404);
    expect(imageResponseCalls).toHaveLength(0);
  });

  it("still renders when the background fetch fails — never a broken og:image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    const res = await get();
    expect(imageResponseCalls).toHaveLength(1);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("still renders when object storage answers non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await get();
    expect(imageResponseCalls).toHaveLength(1);
  });

  it("still renders when the database read throws", async () => {
    // A lookup failure degrades to 404 (the crawler falls back to no image)
    // rather than surfacing a 500 to Facebook.
    findSocialPreviewForCard.mockRejectedValue(new Error("db down"));
    expect((await get()).status).toBe(404);
  });

  it("serves JPEG, not the PNG Satori produces — WhatsApp drops a heavy thumbnail", async () => {
    // Measured in production on 2026-08-26: the PNG composites weighed 921 KB
    // and 1.45 MB, against a ~300 KB ceiling for a WhatsApp link preview.
    const res = await get();
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(sharpJpeg).toHaveBeenCalledWith({ quality: 80 });
  });

  it("re-encodes harder when quality 80 still overshoots the ceiling", async () => {
    toBuffer.mockResolvedValueOnce(Buffer.alloc(400_000));
    toBuffer.mockResolvedValueOnce(Buffer.alloc(180_000));
    const res = await get();
    expect(sharpJpeg).toHaveBeenNthCalledWith(1, { quality: 80 });
    expect(sharpJpeg).toHaveBeenNthCalledWith(2, { quality: 60 });
    expect((await res.arrayBuffer()).byteLength).toBe(180_000);
  });

  it("serves the PNG untouched when re-encoding fails — never a broken og:image", async () => {
    sharpFn.mockImplementation(() => {
      throw new Error("libvips exploded");
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("bounds the background fetch with a timeout so a slow bucket can't stall a crawler", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(new Uint8Array([1]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await get();
    expect(fetchSpy.mock.calls[0][1]).toHaveProperty("signal");
  });
});
