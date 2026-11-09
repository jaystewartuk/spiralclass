import { describe, expect, it, vi } from "vitest";
import {
  createPcmCapture,
  PcmDownsampler,
  type AudioContextCtorLike,
} from "@/lib/captions/pcm-capture";

// Raw audio for a browser that cannot record a format Deepgram detects
// (Safari before 18.4): samples leave at the rate the socket was opened with,
// across buffer boundaries, and the audio graph never reaches the speakers.

const samples = (buffer: ArrayBuffer) => [...new Int16Array(buffer)];

describe("PcmDownsampler", () => {
  it("turns 48 kHz into a third as many 16-bit samples", () => {
    const out = new PcmDownsampler(48_000, 16_000).push(new Float32Array(4800).fill(0.5));
    expect(samples(out)).toHaveLength(1600);
    expect(samples(out)[0]).toBe(Math.round(0.5 * 0x7fff));
  });

  it("averages the input between output samples", () => {
    const out = new PcmDownsampler(48_000, 16_000).push(new Float32Array([0.3, 0.6, 0.9]));
    expect(samples(out)[0]).toBe(Math.round(0.6 * 0x7fff));
  });

  it("keeps the rate true over many buffers at a rate that does not divide evenly", () => {
    const d = new PcmDownsampler(44_100, 16_000);
    let total = 0;
    for (let i = 0; i < 441; i++) total += samples(d.push(new Float32Array(1000))).length;
    expect(Math.abs(total - 160_000)).toBeLessThanOrEqual(1);
  });

  it("carries a partial output sample into the next buffer", () => {
    const d = new PcmDownsampler(48_000, 16_000);
    expect(d.push(new Float32Array([1, 1])).byteLength).toBe(0);
    expect(samples(d.push(new Float32Array([1])))).toEqual([0x7fff]);
  });

  it("clamps a sample outside the legal range rather than wrapping it", () => {
    const d = new PcmDownsampler(16_000, 16_000);
    expect(samples(d.push(new Float32Array([2, -2])))).toEqual([0x7fff, -0x7fff]);
  });
});

function fakeContext({ sampleRate = 48_000, createThrows = false } = {}) {
  const connections: [unknown, unknown][] = [];
  const node = (name: string) => ({
    name,
    connect(target: unknown) {
      connections.push([name, target]);
    },
    disconnect: vi.fn(),
    onaudioprocess: null as
      ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null,
    gain: { value: 1 },
  });
  const source = node("source");
  const processor = node("processor");
  const silence = node("silence");
  const resume = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const Ctor = class {
    sampleRate = sampleRate;
    destination = "speakers";
    resume = resume;
    close = close;
    createMediaStreamSource() {
      if (createThrows) throw new Error("no");
      return source;
    }
    createScriptProcessor() {
      return processor;
    }
    createGain() {
      return silence;
    }
  } as unknown as AudioContextCtorLike;
  return { Ctor, source, processor, silence, connections, resume, close };
}

const stream = {} as MediaStream;

describe("createPcmCapture", () => {
  it("is null without an AudioContext", () => {
    expect(createPcmCapture({ AudioContext: null, stream, onFrame: () => {} })).toBeNull();
  });

  it("wires the mic through a muted gain, so the student never hears herself", () => {
    const f = fakeContext();
    createPcmCapture({ AudioContext: f.Ctor, stream, onFrame: () => {} });
    expect(f.silence.gain.value).toBe(0);
    expect(f.connections).toEqual([
      ["source", f.processor],
      ["processor", f.silence],
      ["silence", "speakers"],
    ]);
    expect(f.resume).toHaveBeenCalled();
  });

  it("hands on each frame, and skips one too short to produce a sample", () => {
    const f = fakeContext();
    const frames: ArrayBuffer[] = [];
    createPcmCapture({ AudioContext: f.Ctor, stream, onFrame: (x) => frames.push(x) });
    const process = (length: number) =>
      f.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(length) },
      });
    process(1);
    expect(frames).toHaveLength(0);
    process(300);
    expect(frames).toHaveLength(1);
  });

  it("releases the graph and the context on stop", () => {
    const f = fakeContext();
    createPcmCapture({ AudioContext: f.Ctor, stream, onFrame: () => {} })?.stop();
    expect(f.processor.onaudioprocess).toBeNull();
    expect(f.source.disconnect).toHaveBeenCalled();
    expect(f.close).toHaveBeenCalled();
  });

  it("gives up cleanly when the graph cannot be built", () => {
    const f = fakeContext({ createThrows: true });
    expect(createPcmCapture({ AudioContext: f.Ctor, stream, onFrame: () => {} })).toBeNull();
    expect(f.close).toHaveBeenCalled();
  });

  it("refuses a context too slow to fill the rate Deepgram was promised", () => {
    const f = fakeContext({ sampleRate: 8_000 });
    expect(createPcmCapture({ AudioContext: f.Ctor, stream, onFrame: () => {} })).toBeNull();
  });
});
