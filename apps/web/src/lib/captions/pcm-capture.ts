import { CLOUD_PCM_SAMPLE_RATE } from "@spiralclass/shared";

// Raw audio for the cloud caption fallback, for a browser whose MediaRecorder
// cannot produce a format Deepgram detects in a stream (D-185). Safari before
// 18.4 records MP4 only, so a student on it reached the fallback and stopped
// there, and her teacher saw none of her words.
//
// A ScriptProcessorNode rather than an AudioWorklet on purpose: this path
// exists for older browsers, the node works in all of them, and a worklet
// would be one more script for the page's Content-Security-Policy to admit.
// It captures the call's own microphone track, so muting the call mutes what
// is streamed, and it runs through a silent gain because Safari only processes
// a node that reaches the destination.

const BUFFER_SIZE = 4096;

type AudioNodeLike = { connect(target: unknown): void; disconnect(): void };
type ProcessorLike = AudioNodeLike & {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
};
type GainLike = AudioNodeLike & { gain: { value: number } };

export type AudioContextLike = {
  readonly sampleRate: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): ProcessorLike;
  createGain(): GainLike;
};
export type AudioContextCtorLike = new () => AudioContextLike;

export type PcmCapture = { stop(): void };

// Float samples at the browser's rate → 16-bit samples at the rate the socket
// was opened with, averaging the input between output samples. Stateful
// because an output sample usually spans two of the browser's buffers.
export class PcmDownsampler {
  private readonly ratio: number;
  private position = 0;
  private sum = 0;
  private count = 0;

  constructor(inputRate: number, outputRate: number = CLOUD_PCM_SAMPLE_RATE) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): ArrayBuffer {
    const output = new Int16Array(Math.ceil(input.length / this.ratio) + 1);
    let written = 0;
    for (const sample of input) {
      this.sum += sample;
      this.count += 1;
      this.position += 1;
      if (this.position >= this.ratio) {
        this.position -= this.ratio;
        const mean = Math.max(-1, Math.min(1, this.sum / this.count));
        output[written++] = Math.round(mean * 0x7fff);
        this.sum = 0;
        this.count = 0;
      }
    }
    return output.buffer.slice(0, written * Int16Array.BYTES_PER_ELEMENT) as ArrayBuffer;
  }
}

// Null when this browser cannot do it, which the fallback reports as
// unsupported rather than throwing mid-call.
export function createPcmCapture(args: {
  AudioContext: AudioContextCtorLike | null;
  stream: MediaStream;
  onFrame: (frame: ArrayBuffer) => void;
}): PcmCapture | null {
  if (!args.AudioContext) return null;
  let context: AudioContextLike | null = null;
  try {
    context = new args.AudioContext();
    if (context.sampleRate < CLOUD_PCM_SAMPLE_RATE) throw new Error("sample rate too low");
    const source = context.createMediaStreamSource(args.stream);
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;
    const downsampler = new PcmDownsampler(context.sampleRate);
    processor.onaudioprocess = (event) => {
      const frame = downsampler.push(event.inputBuffer.getChannelData(0));
      if (frame.byteLength > 0) args.onFrame(frame);
    };
    source.connect(processor);
    processor.connect(silence);
    silence.connect(context.destination);
    // A context created outside a click can start suspended.
    void context.resume().catch(() => {});

    const running = context;
    return {
      stop: () => {
        processor.onaudioprocess = null;
        for (const node of [source, processor, silence]) {
          try {
            node.disconnect();
          } catch {
            // Already disconnected.
          }
        }
        void running.close().catch(() => {});
      },
    };
  } catch {
    void context?.close().catch(() => {});
    return null;
  }
}
