import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken, isWellFormedInvitationToken } from "./token";

describe("invitation token", () => {
  it("generates high-entropy, unique, url-safe tokens", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    // base64url: no +/= and long enough to be unguessable.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("hashes deterministically and never returns the raw token", () => {
    const token = generateInvitationToken();
    const h1 = hashInvitationToken(token);
    const h2 = hashInvitationToken(token);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(token);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("produces different hashes for different tokens", () => {
    expect(hashInvitationToken("a")).not.toBe(hashInvitationToken("b"));
  });

  it("validates token shape", () => {
    expect(isWellFormedInvitationToken(generateInvitationToken())).toBe(true);
    expect(isWellFormedInvitationToken("short")).toBe(false);
    expect(isWellFormedInvitationToken("has spaces and !@#$")).toBe(false);
    expect(isWellFormedInvitationToken("")).toBe(false);
  });
});
