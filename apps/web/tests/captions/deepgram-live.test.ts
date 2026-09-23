import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { deepgramListenUrl, deepgramLiveLanguage, grantDeepgramToken, GRANT_TTL_SECONDS } =
  await import("@/lib/captions/deepgram-live");

// The Deepgram half of live captions' phone-to-phone fallback: which language
// a speaker is streamed in, the socket URL the browser opens, and minting the
// short-lived token it opens it with. Every grant failure comes back as a
// value the route turns into one clean error — never a throw into a live call.

afterEach(() => vi.unstubAllEnvs());

function fakeFetch(res: Response | Error) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (res instanceof Error) throw res;
    return res;
  });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("deepgramLiveLanguage", () => {
  it("keeps a regional variant Deepgram publishes", () => {
    expect(deepgramLiveLanguage("en-GB")).toBe("en-GB");
    expect(deepgramLiveLanguage("pt-BR")).toBe("pt-BR");
    expect(deepgramLiveLanguage("fr-CA")).toBe("fr-CA");
  });

  it("streams every Spanish region but Spain's as Latin American Spanish", () => {
    expect(deepgramLiveLanguage("es-MX")).toBe("es-419");
    expect(deepgramLiveLanguage("es-CO")).toBe("es-419");
    expect(deepgramLiveLanguage("es-ES")).toBe("es");
    expect(deepgramLiveLanguage("es")).toBe("es");
  });

  it("falls back to the bare language for a region Deepgram does not publish", () => {
    expect(deepgramLiveLanguage("en-ZA")).toBe("en");
    expect(deepgramLiveLanguage("fr-BE")).toBe("fr");
    expect(deepgramLiveLanguage("de-AT")).toBe("de");
  });

  it("normalises case", () => {
    expect(deepgramLiveLanguage("EN-gb")).toBe("en-GB");
  });

  it("answers null for a language Nova-3 cannot stream", () => {
    expect(deepgramLiveLanguage("sw")).toBeNull();
    expect(deepgramLiveLanguage("")).toBeNull();
  });
});

describe("deepgramListenUrl", () => {
  it("asks for Nova-3 finals only, formatted, in the given language, kept out of model training", () => {
    const url = new URL(deepgramListenUrl("es-419"));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "nova-3",
      language: "es-419",
      smart_format: "true",
      interim_results: "false",
      mip_opt_out: "true",
    });
  });
});

describe("grantDeepgramToken", () => {
  it("refuses without a key and never calls Deepgram", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    const f = fakeFetch(json({}));
    expect(await grantDeepgramToken(f)).toEqual({ ok: false, reason: "not-configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("asks for a short-lived token with the key in the Token scheme", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", '"dg-key"');
    const f = fakeFetch(json({ access_token: "jwt", expires_in: 30 }));
    expect(await grantDeepgramToken(f)).toEqual({ ok: true, token: "jwt", expiresInSeconds: 30 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.deepgram.com/v1/auth/grant");
    expect(init?.method).toBe("POST");
    // The sanitised key: a quote-wrapped paste is a 400 at Deepgram.
    expect((init?.headers as Record<string, string>).authorization).toBe("Token dg-key");
    expect(JSON.parse(String(init?.body))).toEqual({ ttl_seconds: GRANT_TTL_SECONDS });
  });

  it("assumes the requested lifetime when Deepgram does not say", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-key");
    expect(await grantDeepgramToken(fakeFetch(json({ access_token: "jwt" })))).toEqual({
      ok: true,
      token: "jwt",
      expiresInSeconds: GRANT_TTL_SECONDS,
    });
  });

  it("reports a 4xx as rejected — a key below the Member role is refused 403", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-key");
    const f = fakeFetch(json({ err_code: "FORBIDDEN" }, 403));
    expect(await grantDeepgramToken(f)).toEqual({ ok: false, reason: "rejected", status: 403 });
  });

  it("reports a 5xx, a network failure or a body with no token as unavailable", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-key");
    expect(await grantDeepgramToken(fakeFetch(json({}, 503)))).toEqual({
      ok: false,
      reason: "unavailable",
      status: 503,
    });
    expect(await grantDeepgramToken(fakeFetch(new Error("offline")))).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await grantDeepgramToken(fakeFetch(new Response("not json")))).toEqual({
      ok: false,
      reason: "unavailable",
      status: 200,
    });
  });
});
