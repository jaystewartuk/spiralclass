import "server-only";
import {
  elevenLabsApiKey,
  elevenLabsModelId,
  elevenLabsVoiceId,
  hasElevenLabsCreds,
} from "@/lib/env";
import { logger } from "@/lib/logger";
import { PODCAST_SCRIPT_MAX_CHARS } from "@/lib/materials/config";

const log = logger({ surface: "ai" });

// ElevenLabs text-to-speech — renders a podcast script into a single-narrator
// mp3. Routed through the PLATFORM ElevenLabs key only (never per-teacher),
// mirroring the Anthropic integration next door: no SDK (the rest of the repo
// talks to R2/Deepgram/Azure over plain fetch too), a graceful "not-configured"
// result when no key so the module imports cleanly in dev/tests, and callers
// gate on hasElevenLabsCreds() before reaching here.
//
// The REST call posts the script to the text-to-speech endpoint and reads back
// raw mp3 bytes (Accept: audio/mpeg). Input is bounded to PODCAST_SCRIPT_MAX_CHARS
// before sending — both because ElevenLabs caps a single request's input and
// because TTS is metered per character.

const API_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
// 44.1kHz / 128kbps mono mp3 — the standard podcast-quality default.
const OUTPUT_FORMAT = "mp3_44100_128";

export type SynthesizePodcastResult =
  | { ok: true; audio: Uint8Array; contentType: "audio/mpeg"; voiceId: string }
  | { ok: false; reason: "not-configured" | "empty" | "error" };

export async function synthesizePodcast(
  text: string,
  opts?: { voiceId?: string; modelId?: string },
): Promise<SynthesizePodcastResult> {
  if (!hasElevenLabsCreds()) return { ok: false, reason: "not-configured" };

  const body = text.trim().slice(0, PODCAST_SCRIPT_MAX_CHARS);
  if (!body) return { ok: false, reason: "empty" };

  const voiceId = opts?.voiceId ?? elevenLabsVoiceId();
  const modelId = opts?.modelId ?? elevenLabsModelId();

  try {
    const res = await fetch(
      `${API_BASE}/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsApiKey() as string,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: body,
          model_id: modelId,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.error("elevenlabs synth failed", { status: res.status, body: detail.slice(0, 200) });
      return { ok: false, reason: "error" };
    }

    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength === 0) return { ok: false, reason: "empty" };
    return { ok: true, audio, contentType: "audio/mpeg", voiceId };
  } catch (err) {
    log.error("elevenlabs synth threw", err);
    return { ok: false, reason: "error" };
  }
}
