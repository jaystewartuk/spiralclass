import { describe, expect, it } from "vitest";

import { SENTRY_DENY_URLS, SENTRY_IGNORE_ERRORS } from "@/lib/sentry-noise-filters";

// Pins the exact SPIRALCLASS-2T noise (wallet-extension `window.ethereum`
// injection) as matched, and confirms these regexes don't accidentally widen
// to swallow real app errors.

describe("SENTRY_IGNORE_ERRORS", () => {
  it("matches the SPIRALCLASS-2T wallet-extension error", () => {
    const message =
      "undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')";
    expect(SENTRY_IGNORE_ERRORS.some((re) => re.test(message))).toBe(true);
  });

  it("does not match an unrelated app error", () => {
    const message = "TypeError: Cannot read properties of undefined (reading 'classesUsed')";
    expect(SENTRY_IGNORE_ERRORS.some((re) => re.test(message))).toBe(false);
  });
});

describe("SENTRY_DENY_URLS", () => {
  it("matches known browser-extension URL schemes", () => {
    const urls = [
      "chrome-extension://abcdefghijklmnop/inject.js",
      "moz-extension://12345678-1234-1234-1234-123456789012/inject.js",
      "safari-extension://com.example.wallet/inject.js",
      "safari-web-extension://com.example.wallet/inject.js",
    ];
    for (const url of urls) {
      expect(SENTRY_DENY_URLS.some((re) => re.test(url))).toBe(true);
    }
  });

  it("does not match the app's own origin", () => {
    const urls = [
      "https://spiralclass.com/_next/static/chunks/main.js",
      "https://preview.spiralclass.com/b/some-teacher/buy",
    ];
    for (const url of urls) {
      expect(SENTRY_DENY_URLS.some((re) => re.test(url))).toBe(false);
    }
  });
});
