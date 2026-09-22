import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { geminiVertexServiceAccount } from "@/lib/env";
import { __resetVertexAccessTokenCacheForTests, getVertexAccessToken } from "./google-vertex-auth";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  geminiVertexServiceAccount: vi.fn(),
}));

// A real RSA key so signJwt's createSign(...).sign(privateKey) doesn't throw
// on a garbage PEM — the test never verifies the signature, just that the
// request is attempted.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_ACCOUNT = {
  clientEmail: "test@example-project-00000.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};

const mockedGeminiVertexServiceAccount = vi.mocked(geminiVertexServiceAccount);

describe("getVertexAccessToken", () => {
  beforeEach(() => {
    __resetVertexAccessTokenCacheForTests();
    mockedGeminiVertexServiceAccount.mockReturnValue(TEST_ACCOUNT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns undefined when no service account is configured", async () => {
    mockedGeminiVertexServiceAccount.mockReturnValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVertexAccessToken()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the signed JWT for a bearer token on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVertexAccessToken()).resolves.toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("caches the token across calls instead of re-minting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await getVertexAccessToken();
    await getVertexAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression test for the 2026-08-26 incident: this fetch used to carry no
  // AbortSignal at all, so a slow/unresponsive token endpoint held the
  // request open indefinitely. A burst of concurrent generate calls (a
  // teacher retrying a stuck "Generate" button) each hanging forever was
  // enough to pin every concurrency slot Fly's proxy allows the machine,
  // which read as a full site outage rather than "image generation is slow."
  it("gives up and returns undefined instead of hanging forever when the token endpoint never responds", async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = getVertexAccessToken();
    // The real timeout is 10s; assert it's bounded at all rather than coupling
    // the test to the exact constant.
    await expect(
      Promise.race([
        promise,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("getVertexAccessToken did not resolve in time")),
            15_000,
          ),
        ),
      ]),
    ).resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }, 20_000);

  it("returns undefined when the token endpoint responds with an error status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVertexAccessToken()).resolves.toBeUndefined();
  });
});
