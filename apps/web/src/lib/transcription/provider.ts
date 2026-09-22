import { transcriptionConfig } from "./config";
import { transcribeWithDeepgram } from "./deepgram";
import type { TranscriptionResult } from "./types";

// Transcription seam (lesson-insights Phase B, D-19) — mirrors the VideoProvider
// pattern so the ASR vendor is swappable. getTranscriptionProvider() returns
// null when no vendor is configured, so callers degrade gracefully (exactly like
// getVideoProvider() / the Anthropic gate). The Deepgram-vs-AssemblyAI choice is
// open pending a bake-off on real Phase-A clips; only the Deepgram adapter ships
// here, behind this interface.

export interface TranscriptionProvider {
  readonly vendor: string;
  transcribe(input: { audioUrl: string; language: string }): Promise<TranscriptionResult>;
}

export function getTranscriptionProvider(): TranscriptionProvider | null {
  const cfg = transcriptionConfig();
  if (!cfg) return null;

  if (cfg.vendor === "deepgram") {
    return {
      vendor: "deepgram",
      transcribe: (input) => transcribeWithDeepgram(cfg.apiKey, input),
    };
  }

  // AssemblyAI adapter is intentionally not built yet (bake-off pending, D-19).
  // Configuring only ASSEMBLYAI_API_KEY therefore leaves the pipeline dormant.
  return null;
}
