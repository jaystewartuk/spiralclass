import { baseLanguage, chooseTranslationRoute, type CallRole } from "@spiralclass/shared";
import type { TranslatorApiLike, TranslatorLike } from "@/lib/captions/recognizer";

// Translates one speaker's finished utterances for one class (D-185): on the
// device when the browser has a translator for the pair (desktop Chrome),
// through POST /api/captions/translate otherwise — and not at all when both
// sides share a language. The route is chosen once, lazily, and only ever
// moves from the device to the server: a translator that fails to load, or
// fails on a line, hands every later line to the server rather than trying
// the device again mid-class.
//
// A line that cannot be translated is dropped (null), never shown
// untranslated: the listener reads the captions BECAUSE she does not speak
// the source language.

export type TranslationRefusal = "captions-off" | "no-consent" | "not-entitled" | "not-found";

export type CaptionTranslatorOptions = {
  bookingId: string;
  // Whose speech this translator handles — the route re-checks consent
  // for the student's.
  speaker: CallRole;
  source: string;
  target: string;
  Translator: TranslatorApiLike | null;
  fetch: typeof fetch;
  // The server refused for a reason retrying cannot fix; the caller stops
  // this speaker's recognition and re-reads the class config.
  onRefused: (reason: TranslationRefusal) => void;
  now?: () => number;
};

type Route = "none" | "device" | "server";

const REFUSALS: readonly string[] = ["captions-off", "no-consent", "not-entitled", "not-found"];

export class CaptionTranslator {
  private route: Promise<Route> | null = null;
  private device: Promise<TranslatorLike | null> | null = null;
  // The server said "slow down"; lines until then are dropped rather than
  // queued, because a caption that arrives a minute late is not a caption.
  private pausedUntil = 0;
  private readonly now: () => number;

  constructor(private readonly opts: CaptionTranslatorOptions) {
    this.now = opts.now ?? Date.now;
  }

  async translate(text: string): Promise<string | null> {
    const route = await this.resolveRoute();
    if (route === "none") return text;
    if (route === "device") {
      const translated = await this.translateOnDevice(text);
      if (translated !== null) return translated;
      // The device failed this line; the server takes it and every later one.
      this.route = Promise.resolve("server");
    }
    return this.translateOnServer(text);
  }

  private resolveRoute(): Promise<Route> {
    this.route ??= (async () => {
      const { Translator, source, target } = this.opts;
      let availability: string | null = null;
      if (Translator) {
        try {
          availability = await Translator.availability({
            sourceLanguage: baseLanguage(source),
            targetLanguage: baseLanguage(target),
          });
        } catch {
          availability = null;
        }
      }
      return chooseTranslationRoute(source, target, availability);
    })();
    return this.route;
  }

  private async translateOnDevice(text: string): Promise<string | null> {
    const { Translator, source, target } = this.opts;
    if (!Translator) return null;
    // create() downloads the model when it is only "downloadable", and Chrome
    // refuses that without a user gesture. The teacher's toggle click starts
    // the download (installOnDeviceModels); a browser that has not had one
    // lands here, fails, and uses the server — which is the right answer
    // for this class, not an error.
    this.device ??= Translator.create({
      sourceLanguage: baseLanguage(source),
      targetLanguage: baseLanguage(target),
    }).catch(() => null);
    const translator = await this.device;
    if (!translator) return null;
    try {
      const out = (await translator.translate(text)).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  private async translateOnServer(text: string): Promise<string | null> {
    if (this.now() < this.pausedUntil) return null;
    let res: Response;
    try {
      res = await this.opts.fetch("/api/captions/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: this.opts.bookingId, speaker: this.opts.speaker, text }),
      });
    } catch {
      return null;
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      text?: unknown;
      reason?: string;
      retryAfterMs?: number;
    } | null;
    if (res.ok && body?.ok && typeof body.text === "string") return body.text;
    if (res.status === 429) {
      this.pausedUntil = this.now() + Math.max(1_000, body?.retryAfterMs ?? 30_000);
      return null;
    }
    if (body?.reason && REFUSALS.includes(body.reason)) {
      this.opts.onRefused(body.reason as TranslationRefusal);
    }
    return null;
  }
}
