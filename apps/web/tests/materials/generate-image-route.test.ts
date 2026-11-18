import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/materials/images/generate: authenticated, Pro-gated on the same
// entitlement as uploading an image, and validated before anything is spent.

vi.mock("server-only", () => ({}));

const requireApiOnboardedTeacher = vi.fn();
const gateProFeature = vi.fn();
const generateMaterialImage = vi.fn();

vi.mock("@/lib/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/auth")>("@/lib/api/auth");
  return { ...actual, requireApiOnboardedTeacher };
});
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "es" }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature,
  upgradeNudge: () => "Hazte Pro",
}));
vi.mock("@/lib/materials/generate-image", () => ({ generateMaterialImage }));
vi.mock("@/lib/analytics/posthog", () => ({ flushAnalytics: async () => {} }));

const { POST } = await import("@/app/api/materials/images/generate/route");
const { ApiAuthError } = await import("@/lib/api/auth");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/materials/images/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireApiOnboardedTeacher.mockResolvedValue({ id: "teacher-1" });
  gateProFeature.mockResolvedValue({ ok: true });
  generateMaterialImage.mockResolvedValue({ ok: true, src: "material-image:k.png" });
});

describe("POST /api/materials/images/generate", () => {
  it("returns the src of the generated image", async () => {
    const res = await post({ description: "  Un mercado   por la mañana " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, src: "material-image:k.png" });
    expect(generateMaterialImage).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "teacher-1", description: "Un mercado por la mañana" }),
    );
  });

  it("refuses a caller with no session before anything else", async () => {
    requireApiOnboardedTeacher.mockRejectedValue(new ApiAuthError(401, "no-session"));
    const res = await post({ description: "Un mercado" });
    expect(res.status).toBe(401);
    expect(gateProFeature).not.toHaveBeenCalled();
    expect(generateMaterialImage).not.toHaveBeenCalled();
  });

  it("is Pro-gated on class content, like uploading an image", async () => {
    gateProFeature.mockResolvedValue({ ok: false, limit: "class_content" });
    const res = await post({ description: "Un mercado" });
    expect(res.status).toBe(403);
    expect(gateProFeature).toHaveBeenCalledWith("teacher-1", "class_content");
    expect(generateMaterialImage).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ description: "  a " }], [{ description: "x".repeat(601) }], ["nope"]])(
    "rejects a missing, too-short or too-long description: %j",
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(generateMaterialImage).not.toHaveBeenCalled();
    },
  );

  it("passes the teacher-facing message through with a status for each failure", async () => {
    generateMaterialImage.mockResolvedValue({
      ok: false,
      reason: "throttled",
      message: "Espera unos minutos",
    });
    const res = await post({ description: "Un mercado" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, message: "Espera unos minutos" });
  });
});
