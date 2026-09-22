import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("merges tailwind classes, later wins", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("drops falsy values", () => {
    expect(cn("text-sm", false, undefined, "font-bold")).toBe("text-sm font-bold");
  });
});

describe("slug generator", () => {
  it("strips diacritics and appends a random suffix", async () => {
    const { generateBookingSlug } = await import("@/lib/slug");
    const slug = generateBookingSlug("María-José@Example.com");
    expect(slug).toMatch(/^maria-jose-[a-f0-9]{6}$/);
  });

  it("falls back to 'teacher' when the local-part is empty", async () => {
    const { generateBookingSlug } = await import("@/lib/slug");
    const slug = generateBookingSlug("@example.com");
    expect(slug).toMatch(/^teacher-[a-f0-9]{6}$/);
  });

  it("produces distinct slugs on repeated calls", async () => {
    const { generateBookingSlug } = await import("@/lib/slug");
    const a = generateBookingSlug("mira@example.com");
    const b = generateBookingSlug("mira@example.com");
    expect(a).not.toBe(b);
  });
});
