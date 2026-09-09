import "server-only";
import type { AppLocale } from "@/lib/i18n";
import { hasGoogleTtsCreds } from "@/lib/env";

// Vendor-neutral text-to-speech seam for material podcasts. The Inngest job and
// UI only ever call synthesizePodcast() from here; the concrete rail is chosen
// by which credentials are set — Google (preferred: cheap pay-as-you-go, and
// unlike ElevenLabs' free tier it isn't blocked from datacenter IPs) with
// ElevenLabs as the fallback. Both providers are imported dynamically (they pull
// `server-only`) so this module's static graph — and the route-inventory test
// that loads every handler — stays clean.

export type SynthesizePodcastResult =
  | { ok: true; audio: Uint8Array; contentType: "audio/mpeg"; voiceId: string }
  | { ok: false; reason: string };

export type SynthesizeOpts = {
  // The language the narration is spoken in, as a display name (e.g. "Spanish",
  // "French"). Vendors that need an explicit language (Google) map it to a voice;
  // ElevenLabs' single multilingual model ignores it. Null → derive from `locale`.
  language?: string | null;
  // UI locale — the fallback when `language` is unset (the common case today).
  locale?: AppLocale;
};

// Render a podcast script to mp3 via whichever rail is configured. Google wins
// when its key is present; otherwise ElevenLabs. Both return the same shape.
export async function synthesizePodcast(
  text: string,
  opts?: SynthesizeOpts,
): Promise<SynthesizePodcastResult> {
  if (hasGoogleTtsCreds()) {
    const { synthesizeWithGoogle } = await import("./google-tts");
    return synthesizeWithGoogle(text, opts);
  }
  const { synthesizePodcast: synthesizeWithElevenLabs } = await import("./elevenlabs");
  return synthesizeWithElevenLabs(text);
}
