import { describe, expect, it } from "vitest";
import { initialMicHealth, localMicLevel, MIC_OBSERVATION_MS, sampleMicHealth } from "./mic-health";
const sample = (
  state = initialMicHealth(),
  level = 0.005,
  now = 0,
  enabled = true,
  remotePresent = true,
) => sampleMicHealth(state, { level, now, enabled, remotePresent });
describe("published microphone health", () => {
  it("warns within a minute for the failed tablet's noise floor", () => {
    let state = initialMicHealth();
    for (let now = 0; now <= MIC_OBSERVATION_MS; now += 250) {
      const result = sample(state, now % 500 ? 0.0006 : 0.005, now);
      expect(result.status).toBe(now < MIC_OBSERVATION_MS ? "ok" : "silent");
      state = result.state;
    }
    expect(state.peakLevel).toBe(0.005);
  });
  it("does not warn when a working speaker greets then listens indefinitely", () => {
    let state = sample(undefined, 0.4).state;
    for (let now = 250; now < 300_000; now += 250) {
      const result = sample(state, 0, now);
      expect(result.status).toBe("ok");
      state = result.state;
    }
  });
  it("warns immediately for digital zero and recovers only once", () => {
    const silent = sample(undefined, 0);
    expect(silent.status).toBe("silent");
    const recovered = sample(silent.state, 0.41, 250);
    expect(recovered.status).toBe("recovered");
    expect(sample(recovered.state, 0, 500).status).toBe("ok");
  });
  it("resets on mute or remote departure, without reporting recovery", () => {
    for (const [enabled, present] of [
      [false, true],
      [true, false],
    ]) {
      const result = sample(sample(undefined, 0).state, 0, 1000, enabled, present);
      expect(result.status).toBe("ok");
      expect(result.state).toEqual(initialMicHealth());
      expect(sample(result.state, 0.005, 100_000).status).toBe("ok");
    }
  });
  it("ignores invalid levels", () => {
    for (const level of [NaN, Infinity, -1, 2]) {
      expect(sample(undefined, level).state).toEqual(initialMicHealth());
      expect(sample(sample(undefined, 0).state, level).status).toBe("silent");
    }
  });
  it("reads only the published local source and leaves missing stats unknown", () => {
    const report = new Map([
      ["remote", { type: "inbound-rtp", kind: "audio", trackIdentifier: "mic", audioLevel: 0.85 }],
      [
        "other",
        { type: "media-source", kind: "audio", trackIdentifier: "other", audioLevel: 0.42 },
      ],
    ]) as unknown as RTCStatsReport;
    expect(localMicLevel(report, "mic")).toBeUndefined();
    (report as unknown as Map<string, unknown>).set("mic", {
      type: "media-source",
      kind: "audio",
      trackIdentifier: "mic",
      audioLevel: 0.005,
    });
    expect(localMicLevel(report, "mic")).toBe(0.005);
  });
});
