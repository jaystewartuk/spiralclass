import { describe, expect, it } from "vitest";
import { assertSameOrigin, CrossOriginError, isSameOrigin } from "@/lib/auth/csrf";

// Same-origin assertion for cookie-authed mutating routes. Covers both
// signals: Sec-Fetch-Site and the Origin/Host host comparison.

function req(headers: Record<string, string>, url = "https://app.example.com/x"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("isSameOrigin", () => {
  it("allows when no cross-origin signal is present", () => {
    expect(isSameOrigin(req({}))).toBe(true);
  });

  it("allows Sec-Fetch-Site same-origin and none", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "none" }))).toBe(true);
  });

  it("rejects Sec-Fetch-Site cross-site and same-site", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("allows a matching Origin host", () => {
    expect(isSameOrigin(req({ origin: "https://app.example.com", host: "app.example.com" }))).toBe(
      true,
    );
  });

  it("rejects an Origin whose host differs from the request host", () => {
    expect(isSameOrigin(req({ origin: "https://evil.example.com", host: "app.example.com" }))).toBe(
      false,
    );
  });

  it("rejects a malformed Origin header", () => {
    expect(isSameOrigin(req({ origin: "not a url", host: "app.example.com" }))).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  it("throws CrossOriginError on a cross-origin request", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toThrow(
      CrossOriginError,
    );
  });

  it("does not throw on a same-origin request", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin" }))).not.toThrow();
  });
});
