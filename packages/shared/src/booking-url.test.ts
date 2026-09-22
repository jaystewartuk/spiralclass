import { describe, expect, it } from "vitest";
import { bookingPageUrl } from "./booking-url";

describe("bookingPageUrl", () => {
  it("builds a URL from a base and slug", () => {
    expect(bookingPageUrl("https://spiralclass.com", "alicia-moreno")).toBe(
      "https://spiralclass.com/b/alicia-moreno",
    );
  });

  it("strips a trailing slash on the base URL", () => {
    expect(bookingPageUrl("https://spiralclass.com/", "alicia-moreno")).toBe(
      "https://spiralclass.com/b/alicia-moreno",
    );
  });

  it("strips every trailing slash, and only trailing ones, in linear time", () => {
    expect(bookingPageUrl("https://spiralclass.com///", "a")).toBe("https://spiralclass.com/b/a");
    const slashes = "/".repeat(200_000);
    const started = performance.now();
    expect(bookingPageUrl(`https://x.test${slashes}x`, "a")).toBe(`https://x.test${slashes}x/b/a`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("encodes special characters in the slug", () => {
    expect(bookingPageUrl("https://spiralclass.com", "alicia moreno")).toBe(
      "https://spiralclass.com/b/alicia%20moreno",
    );
  });

  it("returns null for a missing slug", () => {
    expect(bookingPageUrl("https://spiralclass.com", undefined)).toBeNull();
    expect(bookingPageUrl("https://spiralclass.com", null)).toBeNull();
  });

  it("returns null for a blank slug", () => {
    expect(bookingPageUrl("https://spiralclass.com", "   ")).toBeNull();
    expect(bookingPageUrl("https://spiralclass.com", "")).toBeNull();
  });

  it("trims surrounding whitespace on an otherwise valid slug", () => {
    expect(bookingPageUrl("https://spiralclass.com", "  alicia-moreno  ")).toBe(
      "https://spiralclass.com/b/alicia-moreno",
    );
  });
});
