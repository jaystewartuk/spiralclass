import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { translateWithGoogle } = await import("@/lib/captions/google-translate");

// The Google Cloud Translation client behind the live-caption fallback. Pins
// the request shape Google needs (bare languages, plain-text format, key in a
// header rather than the URL) and that every failure comes back as a value
// the route can turn into one clean error — never a throw into a live call.

afterEach(() => vi.unstubAllEnvs());

function fakeFetch(res: Response | Error) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (res instanceof Error) throw res;
    return res;
  });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("translateWithGoogle", () => {
  it("refuses without a key and never calls Google", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    const f = fakeFetch(ok({}));
    expect(await translateWithGoogle("hola", "es", "en", f)).toEqual({
      ok: false,
      reason: "not-configured",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("sends bare languages, plain-text format and the key in a header", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    const f = fakeFetch(ok({ data: { translations: [{ translatedText: "hello" }] } }));

    expect(await translateWithGoogle("hola", "es-MX", "en", f)).toEqual({
      ok: true,
      text: "hello",
    });

    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://translation.googleapis.com/language/translate/v2");
    // Never in the query string, where it would land in every proxy log.
    expect(String(url)).not.toContain("AIza-key");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      q: "hola",
      source: "es",
      target: "en",
      format: "text",
    });
  });

  it("reports a 4xx as rejected, keeping the status for the log", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    const f = fakeFetch(new Response("bad key", { status: 403 }));
    expect(await translateWithGoogle("hola", "es", "en", f)).toEqual({
      ok: false,
      reason: "rejected",
      status: 403,
    });
  });

  it("reports a 5xx as unavailable", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    const f = fakeFetch(new Response("oops", { status: 503 }));
    expect(await translateWithGoogle("hola", "es", "en", f)).toEqual({
      ok: false,
      reason: "unavailable",
      status: 503,
    });
  });

  it("reports a network failure or timeout as unavailable instead of throwing", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    const f = fakeFetch(new Error("socket hang up"));
    expect(await translateWithGoogle("hola", "es", "en", f)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("treats a success with no usable translation as unavailable", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
    for (const body of [
      {},
      { data: { translations: [] } },
      { data: { translations: [{ translatedText: " " }] } },
    ]) {
      expect(await translateWithGoogle("hola", "es", "en", fakeFetch(ok(body)))).toMatchObject({
        ok: false,
        reason: "unavailable",
      });
    }
    const notJson = fakeFetch(new Response("<html>", { status: 200 }));
    expect(await translateWithGoogle("hola", "es", "en", notJson)).toMatchObject({ ok: false });
  });
});
