import { describe, expect, it } from "vitest";
import {
  BOOKING_SLUG_MAX,
  generateBookingSlug,
  normalizeBookingSlug,
  validateBookingSlug,
} from "@/lib/slug";

// generateBookingSlug derives a URL-safe booking slug from the email
// local-part plus a 6-hex-char random suffix. The base must be lowercase,
// ASCII, hyphen-separated, and ≤ 40 chars; the suffix guarantees uniqueness.

const SUFFIX = /-[0-9a-f]{6}$/;

describe("generateBookingSlug", () => {
  it("uses the email local-part as the base", () => {
    const slug = generateBookingSlug("alicia.moreno@example.com");
    expect(slug).toMatch(/^alicia-moreno-[0-9a-f]{6}$/);
  });

  it("strips diacritics and lowercases", () => {
    const slug = generateBookingSlug("Profesóra@example.com");
    expect(slug).toMatch(/^profesora-[0-9a-f]{6}$/);
  });

  it("collapses non-alphanumerics to single hyphens and trims them", () => {
    const slug = generateBookingSlug("a__b--c@example.com");
    expect(slug.replace(SUFFIX, "")).toBe("a-b-c");
  });

  it("falls back to 'teacher' when the local-part has no usable chars", () => {
    const slug = generateBookingSlug("!!!@example.com");
    expect(slug).toMatch(/^teacher-[0-9a-f]{6}$/);
  });

  it("caps the base at 40 characters", () => {
    const slug = generateBookingSlug(`${"x".repeat(80)}@example.com`);
    const base = slug.replace(SUFFIX, "");
    expect(base).toHaveLength(40);
  });

  it("appends a random hex suffix so two calls differ", () => {
    const a = generateBookingSlug("same@example.com");
    const b = generateBookingSlug("same@example.com");
    expect(a).toMatch(SUFFIX);
    expect(a).not.toBe(b);
  });
});

// normalizeBookingSlug turns free-form teacher input into a URL-safe slug:
// lowercase, ASCII, single hyphens, no leading/trailing hyphens, capped length.
describe("normalizeBookingSlug", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeBookingSlug("Profesóra Mira")).toBe("profesora-mira");
  });

  it("collapses runs of non-alphanumerics into single hyphens and trims them", () => {
    expect(normalizeBookingSlug("  --My__Class!!  ")).toBe("my-class");
  });

  it("caps the length at BOOKING_SLUG_MAX", () => {
    expect(normalizeBookingSlug("x".repeat(80))).toHaveLength(BOOKING_SLUG_MAX);
  });

  it("returns an empty string when there are no usable characters", () => {
    expect(normalizeBookingSlug("!!! ¿¿¿")).toBe("");
  });
});

// validateBookingSlug is the offline gate the save action runs before the DB
// uniqueness write: normalize, enforce the length floor and the reserved list.
describe("validateBookingSlug", () => {
  it("accepts and returns the normalized slug", () => {
    expect(validateBookingSlug("Mira María")).toEqual({ ok: true, slug: "mira-maria" });
  });

  it("rejects values shorter than the minimum after normalization", () => {
    expect(validateBookingSlug("a!")).toEqual({ ok: false, reason: "too-short" });
  });

  it("rejects reserved slugs", () => {
    expect(validateBookingSlug("Admin")).toEqual({ ok: false, reason: "reserved" });
  });

  it("normalizes overly long input to the cap instead of rejecting it", () => {
    const result = validateBookingSlug("x".repeat(80));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slug).toHaveLength(BOOKING_SLUG_MAX);
  });
});
