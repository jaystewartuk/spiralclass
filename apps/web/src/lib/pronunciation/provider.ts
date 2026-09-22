import { pronunciationConfig } from "./config";
import { scoreWithAzure } from "./azure";
import type { PronunciationResult } from "./types";

// Pronunciation seam (lesson-insights Phase D, D-19) — mirrors the
// TranscriptionProvider pattern so the vendor is swappable.
// getPronunciationProvider() returns null when no vendor is configured, so
// callers degrade gracefully. Azure is the only adapter (D-19's pick).

export interface PronunciationProvider {
  readonly provider: string;
  score(input: {
    audioUrl: string;
    referenceText: string;
    language: string;
  }): Promise<PronunciationResult>;
}

export function getPronunciationProvider(): PronunciationProvider | null {
  const cfg = pronunciationConfig();
  if (!cfg) return null;
  return {
    provider: "azure",
    score: (input) => scoreWithAzure(cfg, input),
  };
}
