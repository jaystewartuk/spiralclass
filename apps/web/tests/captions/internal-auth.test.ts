import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// apps/web/src/lib/captions/internal-auth.ts — the shared-secret gate on
// /api/internal/captions/*, the one route family a process outside the browser
// calls. Pins three properties:
//
//   1. no configured secret -> closed, so a misconfigured deploy cannot open
//      the endpoint by omission;
//   2. a missing or wrong header -> closed, including a header that is a
//      prefix of the real secret, which is the shape a byte-at-a-time probe
//      would use;
//   3. the comparison is length-safe -- a presented value of a different
//      length must return false, never throw, because `timingSafeEqual` throws
//      on unequal buffer lengths and a throw is both a 500 and a length oracle.

vi.mock("server-only", () => ({}));

let secret: string | undefined;
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CAPTIONS_AGENT_SHARED_SECRET: secret }),
}));

const { captionsAgentAuthOk } = await import("@/lib/captions/internal-auth");

const SECRET = "s3cr3t-agent-value-long-enough-to-be-real";

function req(header?: string): Request {
  return new Request("https://example.test/api/internal/captions/room-config", {
    method: "POST",
    headers: header === undefined ? {} : { "x-captions-agent-secret": header },
  });
}

beforeEach(() => {
  secret = SECRET;
});
afterEach(() => {
  secret = undefined;
});

describe("captionsAgentAuthOk", () => {
  it("accepts the exact secret", () => {
    expect(captionsAgentAuthOk(req(SECRET))).toBe(true);
  });

  it("is closed when no secret is configured, even with a header present", () => {
    secret = undefined;
    expect(captionsAgentAuthOk(req(SECRET))).toBe(false);
    secret = "";
    expect(captionsAgentAuthOk(req(""))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(captionsAgentAuthOk(req())).toBe(false);
  });

  it("rejects a prefix of the secret without throwing on the length difference", () => {
    for (let i = 0; i < SECRET.length; i++) {
      expect(captionsAgentAuthOk(req(SECRET.slice(0, i)))).toBe(false);
    }
  });

  it("rejects a same-length value differing in one byte", () => {
    const nearly = "x" + SECRET.slice(1);
    expect(nearly).toHaveLength(SECRET.length);
    expect(captionsAgentAuthOk(req(nearly))).toBe(false);
  });

  it("rejects a much longer value rather than throwing", () => {
    expect(captionsAgentAuthOk(req(SECRET + "extra".repeat(100)))).toBe(false);
  });
});
