import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The self-signed-JWT → token-exchange flow (RFC 7523) this module hand-rolls
// instead of pulling in google-auth-library (D-127) — same posture as
// wise/api.ts's own node:crypto RSA signing. What matters here: the JWT is
// signed with the RIGHT key and claims Google's token endpoint actually
// checks, the resulting token is cached across calls (a request loop
// shouldn't mint a fresh token every time), and every failure mode degrades
// to `undefined` rather than throwing — a teacher clicking "generate" must
// never see an unhandled exception over a misconfigured credential.

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const TEST_ACCOUNT = {
  clientEmail: "test-sa@example-project-00000.iam.gserviceaccount.com",
  privateKey,
};

const env = vi.hoisted(() => ({
  geminiVertexServiceAccount: vi.fn(
    (): { clientEmail: string; privateKey: string } | undefined => undefined,
  ),
}));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Decodes the two dot-joined base64url segments a JWT is built from and
 * verifies the third against `publicKey` — proof the module signed with the
 * credential it was actually given, not a hardcoded stand-in. */
function decodeAndVerifyJwt(jwt: string): { header: unknown; claims: Record<string, unknown> } {
  const [headerB64, claimsB64, sigB64] = jwt.split(".");
  const signingInput = `${headerB64}.${claimsB64}`;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  expect(verifier.verify(publicKey, Buffer.from(sigB64, "base64url"))).toBe(true);
  return {
    header: JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8")),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  env.geminiVertexServiceAccount.mockReturnValue(undefined);
  const { __resetVertexAccessTokenCacheForTests } = await import("@/lib/ai/google-vertex-auth");
  __resetVertexAccessTokenCacheForTests();
});

describe("getVertexAccessToken", () => {
  it("returns undefined with no credential configured, and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signs a JWT with the configured key, claiming the cloud-platform scope", async () => {
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const params = new URLSearchParams(init.body as string);
      const { header, claims } = decodeAndVerifyJwt(params.get("assertion") ?? "");
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(claims.iss).toBe(TEST_ACCOUNT.clientEmail);
      expect(claims.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
      expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      return jsonResponse({ access_token: "minted-token", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("minted-token");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("caches the token across calls instead of minting one per request", async () => {
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    const fetchSpy = vi.fn(async () => jsonResponse({ access_token: "t1", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("t1");
    expect(await getVertexAccessToken()).toBe("t1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the cached token is within the skew window of expiring", async () => {
    vi.useFakeTimers();
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "t1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "t2", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("t1");
    // 3600s expiry, 60s skew: 3541s in is still fresh, 3541.5s is inside skew.
    vi.advanceTimersByTime(3541_500);
    expect(await getVertexAccessToken()).toBe("t2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns undefined rather than throwing on a transport failure", async () => {
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    await expect(getVertexAccessToken()).resolves.toBeUndefined();
  });

  it("returns undefined on a non-2xx response from the token endpoint", async () => {
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBeUndefined();
  });

  it("returns undefined on an unparseable token response", async () => {
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 200 })),
    );
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBeUndefined();
  });
});
