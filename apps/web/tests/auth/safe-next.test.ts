import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/safe-next";

// The post-auth redirect guard. The bug it fixes: `startsWith("/")` accepts
// protocol-relative and backslash-tricked URLs that browsers resolve off-site,
// so the OAuth completion route + the OTP rail could open-redirect to an
// attacker after a real sign-in.
describe("safeNextPath", () => {
  it("allows genuine internal paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/my-classes?tab=upcoming")).toBe("/my-classes?tab=upcoming");
    expect(safeNextPath("/")).toBe("/");
  });

  it("rejects protocol-relative URLs (the open-redirect vector)", () => {
    expect(safeNextPath("//evil.com")).toBeNull();
    expect(safeNextPath("//evil.com/path")).toBeNull();
  });

  it("rejects backslash-normalized URLs", () => {
    expect(safeNextPath("/\\evil.com")).toBeNull();
  });

  it("rejects control-char-smuggled protocol-relative URLs (browser/URL strips \\t\\n\\r)", () => {
    // `new URL("/\t//evil.com", origin)` resolves to `https://evil.com/` because
    // the WHATWG URL parser strips ASCII tab/newline/CR. Reachable as
    // `?next=/%09//evil.com`; without the control-char reject these slip past the
    // "//" / "/\\" prefix checks and open-redirect after a real sign-in.
    expect(safeNextPath("/\t//evil.com")).toBeNull();
    expect(safeNextPath("/\n//evil.com")).toBeNull();
    expect(safeNextPath("/\r//evil.com")).toBeNull();
    expect(safeNextPath("/\t/\\evil.com")).toBeNull();
    // Sanity: the resolved form really is off-site, proving the vector is real.
    expect(new URL("/\t//evil.com", "https://app.spiralclass.com").host).toBe("evil.com");
  });

  it("rejects absolute URLs and non-path values", () => {
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
    expect(safeNextPath("dashboard")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(123)).toBeNull();
  });
});
