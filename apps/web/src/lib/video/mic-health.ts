// RTP audioLevel is linear RMS: the failed tablet peaked at .005 while
// speech reached .4. .02 leaves room above that noise floor; 45 seconds gives
// a speaker time to greet their partner and warns within the first minute.
export const MIC_SPEECH_LEVEL = 0.02;
export const MIC_OBSERVATION_MS = 45_000;
export const MIC_SAMPLE_MS = 250;

export type MicHealth = {
  startedAt: number | null;
  peakLevel: number;
  proven: boolean;
  silent: boolean;
};
export const initialMicHealth = (): MicHealth => ({
  startedAt: null,
  peakLevel: 0,
  proven: false,
  silent: false,
});

export function sampleMicHealth(
  state: MicHealth,
  sample: {
    level: number;
    now: number;
    enabled: boolean;
    remotePresent: boolean;
  },
): { state: MicHealth; status: "silent" | "ok" | "recovered"; secondsObserved: number } {
  if (!sample.enabled || !sample.remotePresent) {
    return { state: initialMicHealth(), status: "ok", secondsObserved: 0 };
  }
  if (!Number.isFinite(sample.level) || sample.level < 0 || sample.level > 1) {
    return { state, status: state.silent ? "silent" : "ok", secondsObserved: 0 };
  }
  const startedAt = state.startedAt ?? sample.now;
  const peakLevel = Math.max(state.peakLevel, sample.level);
  const proven = state.proven || peakLevel > MIC_SPEECH_LEVEL;
  const secondsObserved = (sample.now - startedAt) / 1000;
  // Once speech proves this publication works, listening is normal, even
  // digital zero from noise suppression. This is a startup check, not VAD.
  const silent = !proven && (peakLevel === 0 || sample.now - startedAt >= MIC_OBSERVATION_MS);
  return {
    state: { startedAt, peakLevel, proven, silent },
    status: state.silent && proven ? "recovered" : silent ? "silent" : "ok",
    secondsObserved,
  };
}

// Missing stats are unknown, never silence. Match the published track so
// inbound speech (or a different local source) cannot prove this mic works.
export function localMicLevel(report: RTCStatsReport, trackId: string): number | undefined {
  let level: number | undefined;
  report.forEach((stat) => {
    if (
      (stat.type === "media-source" || stat.type === "track") &&
      stat.kind === "audio" &&
      stat.trackIdentifier === trackId &&
      typeof stat.audioLevel === "number"
    )
      level = stat.audioLevel;
  });
  return level;
}
