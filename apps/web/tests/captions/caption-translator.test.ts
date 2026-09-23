import { describe, expect, it, vi } from "vitest";
import {
  CaptionTranslator,
  type CaptionTranslatorOptions,
} from "@/lib/captions/caption-translator";

// Where each finished utterance is translated: the device when the browser
// has the pair, the server otherwise, nowhere when both sides share a
// language — and what happens to a line when either fails.

function serverReplies(...replies: { status: number; body: unknown }[]) {
  const queue = [...replies];
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift() ?? { status: 200, body: { ok: true, text: "server" } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
}

function make(over: Partial<CaptionTranslatorOptions> = {}) {
  const onRefused = vi.fn();
  const t = new CaptionTranslator({
    bookingId: "b1",
    speaker: "teacher",
    source: "es",
    target: "en",
    Translator: null,
    fetch: serverReplies(),
    onRefused,
    ...over,
  });
  return { t, onRefused };
}

function deviceTranslator(availability: string, translate = async (s: string) => `device:${s}`) {
  const translator = { translate: vi.fn(translate) };
  return {
    api: {
      availability: vi.fn(async () => availability),
      create: vi.fn(async () => translator),
    },
    translator,
  };
}

describe("CaptionTranslator", () => {
  it("returns the text itself when both sides share a language", async () => {
    const fetch = serverReplies();
    const { t } = make({ source: "es-MX", target: "es", fetch });
    expect(await t.translate("hola")).toBe("hola");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("translates on the device when the browser has the pair", async () => {
    const { api } = deviceTranslator("available");
    const fetch = serverReplies();
    const { t } = make({ Translator: api, fetch });
    expect(await t.translate("hola")).toBe("device:hola");
    expect(fetch).not.toHaveBeenCalled();
    expect(api.availability).toHaveBeenCalledWith({ sourceLanguage: "es", targetLanguage: "en" });
  });

  it("creates the device translator once, however many lines", async () => {
    const { api } = deviceTranslator("available");
    const { t } = make({ Translator: api });
    await t.translate("uno");
    await t.translate("dos");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("uses the server when the browser has no translator", async () => {
    const fetch = serverReplies({ status: 200, body: { ok: true, text: "hello" } });
    const { t } = make({ fetch });
    expect(await t.translate("hola")).toBe("hello");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/captions/translate");
    // Whose speech and the text — never a language; the server decides those.
    expect(JSON.parse(String(init?.body))).toEqual({
      bookingId: "b1",
      speaker: "teacher",
      text: "hola",
    });
  });

  it("uses the server when the device does not have this pair", async () => {
    const { api } = deviceTranslator("unavailable");
    const fetch = serverReplies({ status: 200, body: { ok: true, text: "hello" } });
    const { t } = make({ Translator: api, fetch });
    expect(await t.translate("hola")).toBe("hello");
    expect(api.create).not.toHaveBeenCalled();
  });

  // A student's browser had no gesture to start the download; create() is
  // refused, and the server is the right answer for this class.
  it("moves to the server for good when the device translator cannot be created", async () => {
    const { api } = deviceTranslator("downloadable");
    api.create.mockRejectedValue(new Error("NotAllowedError"));
    const fetch = serverReplies(
      { status: 200, body: { ok: true, text: "one" } },
      { status: 200, body: { ok: true, text: "two" } },
    );
    const { t } = make({ Translator: api, fetch });
    expect(await t.translate("uno")).toBe("one");
    expect(await t.translate("dos")).toBe("two");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("hands a line the device fails on to the server", async () => {
    const { api } = deviceTranslator("available", async () => {
      throw new Error("boom");
    });
    const fetch = serverReplies({ status: 200, body: { ok: true, text: "hello" } });
    const { t } = make({ Translator: api, fetch });
    expect(await t.translate("hola")).toBe("hello");
  });

  it("treats an availability check that throws as no translator", async () => {
    const api = {
      availability: vi.fn(async () => {
        throw new Error("x");
      }),
      create: vi.fn(),
    };
    const fetch = serverReplies({ status: 200, body: { ok: true, text: "hello" } });
    const { t } = make({ Translator: api, fetch });
    expect(await t.translate("hola")).toBe("hello");
  });

  it("drops a line rather than showing it untranslated when the server fails", async () => {
    const { t } = make({
      fetch: serverReplies({ status: 502, body: { reason: "translate-failed" } }),
    });
    expect(await t.translate("hola")).toBeNull();
  });

  it("drops a line when the network fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const { t } = make({ fetch });
    expect(await t.translate("hola")).toBeNull();
  });

  it("pauses server calls for as long as a 429 asks", async () => {
    let now = 1_000;
    const fetch = serverReplies(
      { status: 429, body: { reason: "rate-limited", retryAfterMs: 5_000 } },
      { status: 200, body: { ok: true, text: "later" } },
    );
    const { t } = make({ fetch, now: () => now });
    expect(await t.translate("uno")).toBeNull();
    now += 4_000;
    expect(await t.translate("dos")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1_500;
    expect(await t.translate("tres")).toBe("later");
  });

  it("reports a refusal retrying cannot fix, so the caller can re-read the config", async () => {
    const { t, onRefused } = make({
      speaker: "student",
      fetch: serverReplies({ status: 403, body: { reason: "no-consent" } }),
    });
    expect(await t.translate("hi")).toBeNull();
    expect(onRefused).toHaveBeenCalledWith("no-consent");
  });

  it("does not report an unknown error as a refusal", async () => {
    const { t, onRefused } = make({ fetch: serverReplies({ status: 500, body: { reason: "x" } }) });
    await t.translate("hola");
    expect(onRefused).not.toHaveBeenCalled();
  });
});
