import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "@/lib/security-headers";

// See CLOUDFLARE_PLATFORM_AUDIT.md (docs/architecture) — Vercel applied HSTS
// automatically on its own domains; Fly (production + preview since D-89)
// does not, so this header must be set explicitly or HTTPS-downgrade
// protection is silently absent in production.

function keys(headers: ReturnType<typeof buildSecurityHeaders>) {
  return headers.map((h) => h.key);
}

describe("buildSecurityHeaders", () => {
  it("always includes the baseline framing/content-type/referrer/permissions headers", () => {
    for (const deployEnv of [undefined, "production", "preview"]) {
      const headers = buildSecurityHeaders(deployEnv);
      expect(keys(headers)).toEqual(
        expect.arrayContaining([
          "X-Frame-Options",
          "X-Content-Type-Options",
          "Referrer-Policy",
          "Permissions-Policy",
        ]),
      );
    }
  });

  it("omits Strict-Transport-Security when deployEnv is unset (local/CI builds)", () => {
    const headers = buildSecurityHeaders(undefined);
    expect(keys(headers)).not.toContain("Strict-Transport-Security");
  });

  it("sets Strict-Transport-Security on production", () => {
    const headers = buildSecurityHeaders("production");
    const hsts = headers.find((h) => h.key === "Strict-Transport-Security");
    expect(hsts?.value).toBe("max-age=31536000; includeSubDomains");
    // No `preload` — submitting to browsers' built-in preload list is a
    // separate, effectively irreversible step this repo hasn't taken.
    expect(hsts?.value).not.toContain("preload");
  });

  it("sets Strict-Transport-Security on preview too (it's a real deployed HTTPS site)", () => {
    const headers = buildSecurityHeaders("preview");
    expect(headers.some((h) => h.key === "Strict-Transport-Security")).toBe(true);
  });

  it("sets X-Robots-Tag noindex only on non-production deploys", () => {
    expect(buildSecurityHeaders("preview").find((h) => h.key === "X-Robots-Tag")?.value).toBe(
      "noindex, nofollow",
    );
    expect(buildSecurityHeaders("production").some((h) => h.key === "X-Robots-Tag")).toBe(false);
    expect(buildSecurityHeaders(undefined).some((h) => h.key === "X-Robots-Tag")).toBe(false);
  });

  it("keeps camera/microphone self-scoped and geolocation fully off", () => {
    const headers = buildSecurityHeaders("production");
    expect(headers.find((h) => h.key === "Permissions-Policy")?.value).toBe(
      "geolocation=(), microphone=(self), camera=(self)",
    );
  });
});
