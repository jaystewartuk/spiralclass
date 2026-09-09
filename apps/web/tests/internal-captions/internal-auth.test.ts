import { beforeEach, describe, expect, it, vi } from "vitest";

// captionsAgentAuthOk — the shared-secret gate on /api/internal/captions/*.
// Modeled on a deleted test seam: dark (fails closed) whenever the secret env
// var isn't set, strict header-value comparison otherwise.

// internal-auth.ts is a server module (`import "server-only"`); neutralize
// that guard so it can be unit-tested under the node runner (same pattern as
// tests/captions/translate.test.ts).
vi.mock("server-only", () => ({}));

const state = { secret: "agent-secret" as string | undefined };

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CAPTIONS_AGENT_SHARED_SECRET: state.secret }),
}));

const { captionsAgentAuthOk } = await import("@/lib/captions/internal-auth");

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://test.local/api/internal/captions/room-config", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  state.secret = "agent-secret";
});

describe("captionsAgentAuthOk", () => {
  it("false when the secret env var is unset (the default everywhere)", () => {
    state.secret = undefined;
    expect(captionsAgentAuthOk(req({ "x-captions-agent-secret": "agent-secret" }))).toBe(false);
  });

  it("false when the header is missing", () => {
    expect(captionsAgentAuthOk(req())).toBe(false);
  });

  it("false when the header doesn't match", () => {
    expect(captionsAgentAuthOk(req({ "x-captions-agent-secret": "wrong" }))).toBe(false);
  });

  it("true when the header matches the configured secret", () => {
    expect(captionsAgentAuthOk(req({ "x-captions-agent-secret": "agent-secret" }))).toBe(true);
  });
});
