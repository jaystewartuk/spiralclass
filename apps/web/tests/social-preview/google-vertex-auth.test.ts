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
  runsOnCloudRun: vi.fn((): boolean => false),
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
  env.runsOnCloudRun.mockReturnValue(false);
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

// Production runs on Cloud Run (D-184), whose metadata server hands the
// service's own runtime identity a token on request — so the stored key D-127
// needed on Fly can be retired. Same bounded, cached, never-throwing posture
// as the key exchange above; what differs is where the token comes from and
// which header proves the request came from inside the instance.
describe("getVertexAccessToken on Cloud Run, with no key stored", () => {
  const METADATA_TOKEN_URL =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

  beforeEach(() => {
    env.runsOnCloudRun.mockReturnValue(true);
  });

  it("asks the metadata server for the runtime identity's token, with Metadata-Flavor: Google", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ access_token: "identity-token", expires_in: 3599, token_type: "Bearer" }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("identity-token");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(METADATA_TOKEN_URL);
    expect(new Headers(init.headers).get("Metadata-Flavor")).toBe("Google");
    // Bounded like the key exchange: a wedged metadata server must not hold a
    // teacher's request (and a concurrency slot) open forever.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Nothing signed, nothing posted: no key material exists on this path.
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("caches the token across calls instead of asking the metadata server per request", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ access_token: "m1", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("m1");
    expect(await getVertexAccessToken()).toBe("m1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the cached token is within the skew window of expiring", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "m1", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "m2", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("m1");
    // 3600s expiry, 60s skew: 3539s in is still fresh, 3541.5s is inside skew.
    vi.advanceTimersByTime(3539_000);
    expect(await getVertexAccessToken()).toBe("m1");
    vi.advanceTimersByTime(2_500);
    expect(await getVertexAccessToken()).toBe("m2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns undefined rather than throwing when the metadata server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    await expect(getVertexAccessToken()).resolves.toBeUndefined();
  });

  it("returns undefined when the metadata server times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    await expect(getVertexAccessToken()).resolves.toBeUndefined();
  });

  it("returns undefined on a non-2xx from the metadata server, and does not cache the failure", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "m-retry", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBeUndefined();
    expect(await getVertexAccessToken()).toBe("m-retry");
  });

  it("returns undefined on an unparseable metadata response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>oops</html>", { status: 200 })),
    );
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBeUndefined();
  });

  it("uses the stored key, not the metadata server, while a key is still configured", async () => {
    // The deploy is safe to land before the operator removes the key: until
    // then, production keeps authenticating exactly as it did.
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ access_token: "key-token", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("key-token");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("never serves a token cached for the key once the key is gone", async () => {
    env.geminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "key-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "identity-token", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBe("key-token");
    env.geminiVertexServiceAccount.mockReturnValue(undefined);
    expect(await getVertexAccessToken()).toBe("identity-token");
    expect(fetchSpy.mock.calls[1][0]).toBe(METADATA_TOKEN_URL);
  });
});

describe("getVertexAccessToken off Cloud Run, with no key stored", () => {
  it("returns undefined without calling anything, since a laptop has no metadata server", async () => {
    env.runsOnCloudRun.mockReturnValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getVertexAccessToken } = await import("@/lib/ai/google-vertex-auth");
    expect(await getVertexAccessToken()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
