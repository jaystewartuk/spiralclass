import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The per-participant audio egress for lesson insights (Phase A). Covers the
// object-key scheme, the dormant-when-unconfigured gate, and that the audio
// egress is a TRACK egress (DirectFileOutput) targeting the participant's mic
// track SID — the supplement to the A/V composite, not a replacement.

const startTrackEgress = vi.fn(async (_room: string, _output: unknown, _trackId: string) => ({
  egressId: "EG_audio",
}));
const startRoomCompositeEgress = vi.fn(
  async (_room: string, _opts: { file: unknown }, _compositeOpts?: { audioOnly?: boolean }) => ({
    egressId: "EG_av",
  }),
);
const stopEgressFn = vi.fn(async () => {});
// `new` on a vi.fn() mock forwards to its implementation since vitest 5, and an
// arrow function is not constructible — so these SDK client stubs are plain
// functions returning the stub object, which `new` then yields.
const EgressClient = vi.fn(function () {
  return { startTrackEgress, startRoomCompositeEgress, stopEgress: stopEgressFn };
});

// Capture the output objects the builders construct.
const DirectFileOutput = vi.fn(function (this: any, data: any) {
  Object.assign(this, data);
});
const EncodedFileOutput = vi.fn(function (this: any, data: any) {
  Object.assign(this, data);
});
const S3Upload = vi.fn(function (this: any, data: any) {
  Object.assign(this, data);
});

vi.mock("livekit-server-sdk", () => ({
  EgressClient,
  DirectFileOutput,
  EncodedFileOutput,
  EncodedFileType: { MP4: 1 },
  S3Upload,
}));

const {
  lessonAudioKey,
  callRecordingKey,
  isAudioOnlyRecordingKey,
  startRoomRecording,
  startParticipantAudioEgress,
  stopEgress,
  recordingEnabled,
} = await import("@/lib/video/recording");

function configureEgress() {
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  process.env.LIVEKIT_EGRESS_S3_BUCKET = "bucket";
  process.env.LIVEKIT_EGRESS_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.LIVEKIT_EGRESS_S3_ACCESS_KEY = "ak";
  process.env.LIVEKIT_EGRESS_S3_SECRET = "sk";
}

const EGRESS_VARS = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_EGRESS_S3_BUCKET",
  "LIVEKIT_EGRESS_S3_ENDPOINT",
  "LIVEKIT_EGRESS_S3_ACCESS_KEY",
  "LIVEKIT_EGRESS_S3_SECRET",
  "CLASS_RECORDING_ENABLED",
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const v of EGRESS_VARS) delete process.env[v];
});

describe("lessonAudioKey", () => {
  it("namespaces by booking + speaker + token, with an .ogg suffix", () => {
    expect(lessonAudioKey("b1", "teacher", "1700000000000")).toBe(
      "lesson-audio/b1/teacher-1700000000000.ogg",
    );
  });
});

describe("recordingEnabled", () => {
  it("is false until every egress var is present AND the flag is on", () => {
    expect(recordingEnabled()).toBe(false);
    // Egress fully configured but the flag is OFF (its default) → still hidden.
    configureEgress();
    expect(recordingEnabled()).toBe(false);
    // Flip the explicit enablement flag on → now available.
    process.env.CLASS_RECORDING_ENABLED = "1";
    expect(recordingEnabled()).toBe(true);
  });

  it("stays off when the flag is on but egress isn't configured", () => {
    process.env.CLASS_RECORDING_ENABLED = "true";
    expect(recordingEnabled()).toBe(false);
  });
});

describe("startParticipantAudioEgress (lesson-insights audio)", () => {
  it("does NOT depend on CLASS_RECORDING_ENABLED — only egress config", async () => {
    // The class-recording flag must gate ONLY the visible class recording, not
    // the separate lesson-insights audio capture, which reads egressConfig()
    // directly. So this succeeds with egress configured and the flag unset.
    configureEgress();
    delete process.env.CLASS_RECORDING_ENABLED;
    const { egressId } = await startParticipantAudioEgress("class-b1", "TR_mic", "k.ogg");
    expect(egressId).toBe("EG_audio");
  });
});

describe("startParticipantAudioEgress", () => {
  it("starts a track egress on the mic track SID, writing to the given key", async () => {
    configureEgress();

    const { egressId, storageKey } = await startParticipantAudioEgress(
      "class-b1",
      "TR_mic",
      "lesson-audio/b1/teacher-123.ogg",
    );

    expect(egressId).toBe("EG_audio");
    expect(storageKey).toBe("lesson-audio/b1/teacher-123.ogg");
    expect(startTrackEgress).toHaveBeenCalledTimes(1);
    const [room, output, trackId] = startTrackEgress.mock.calls[0];
    expect(room).toBe("class-b1");
    expect(trackId).toBe("TR_mic");
    expect(output).toBeInstanceOf(DirectFileOutput);
    expect((output as any).filepath).toBe("lesson-audio/b1/teacher-123.ogg");
    expect((output as any).output).toEqual({ case: "s3", value: expect.any(S3Upload) });
  });

  it("throws when egress isn't configured", async () => {
    await expect(startParticipantAudioEgress("class-b1", "TR_mic", "k")).rejects.toThrow(
      "recording-not-configured",
    );
  });
});

describe("callRecordingKey / isAudioOnlyRecordingKey", () => {
  it("writes new recordings under .m4a, scoped to the booking", () => {
    expect(callRecordingKey("b1", "1787853738717")).toBe("recordings/b1/1787853738717.m4a");
  });

  it("classifies a new .m4a key as audio and a legacy .mp4 key as video", () => {
    // The extension is the ONLY signal separating a D-135 audio composite from
    // a recording made before it, and both still live in the same bucket.
    expect(isAudioOnlyRecordingKey("recordings/b1/1.m4a")).toBe(true);
    expect(isAudioOnlyRecordingKey("recordings/b1/1.M4A")).toBe(true);
    expect(isAudioOnlyRecordingKey("recordings/b1/1.mp4")).toBe(false);
    expect(isAudioOnlyRecordingKey(null)).toBe(false);
    expect(isAudioOnlyRecordingKey(undefined)).toBe(false);
  });
});

describe("startRoomRecording", () => {
  it("starts an AUDIO-ONLY room-composite egress writing to the given key", async () => {
    configureEgress();

    const { egressId, storageKey } = await startRoomRecording("class-b1", "recordings/b1/123.m4a");

    expect(egressId).toBe("EG_av");
    expect(storageKey).toBe("recordings/b1/123.m4a");
    expect(startRoomCompositeEgress).toHaveBeenCalledTimes(1);
    const [room, opts, compositeOpts] = startRoomCompositeEgress.mock.calls[0];
    expect(room).toBe("class-b1");
    expect(opts.file).toBeInstanceOf(EncodedFileOutput);
    expect((opts.file as any).filepath).toBe("recordings/b1/123.m4a");
    expect((opts.file as any).fileType).toBe(1); // EncodedFileType.MP4 per the mock
    expect((opts.file as any).output).toEqual({ case: "s3", value: expect.any(S3Upload) });
    // D-135. Without this the composite reverts to LiveKit's default
    // H264_720P_30, which cost 846 MB and 2,586 dropped frames for one class.
    expect(compositeOpts).toEqual({ audioOnly: true });
  });

  it("throws when egress isn't configured", async () => {
    await expect(startRoomRecording("class-b1", "k.mp4")).rejects.toThrow(
      "recording-not-configured",
    );
  });
});

describe("stopEgress", () => {
  it("no-ops when egress isn't configured (nothing to stop)", async () => {
    await stopEgress("EG_x");
    expect(EgressClient).not.toHaveBeenCalled();
  });

  it("stops the egress when configured", async () => {
    configureEgress();
    await stopEgress("EG_x");
    expect(stopEgressFn).toHaveBeenCalledWith("EG_x");
  });
});
