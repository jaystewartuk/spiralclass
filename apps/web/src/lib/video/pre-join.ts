// The pure half of the call's pre-join check (components/video/call-pre-join.tsx):
// what a getUserMedia failure means to the person looking at it, how loud the
// microphone is, and which device to start on.
//
// The check exists because the call used to connect the moment the page
// mounted and only then ask for the camera and microphone. A blocked
// permission, a missing device or a camera another app held all surfaced
// mid-class as "Your camera and microphone are off", with the other person
// already waiting — and nobody could tell whether their own microphone was
// working until the other side said so.

export type MediaProblem = "denied" | "no-device" | "in-use" | "unknown";

// getUserMedia rejects with a DOMException whose `name` is the only stable
// signal across browsers; the message text differs per engine.
export function mediaProblemOf(err: unknown): MediaProblem {
  const name = (err as { name?: unknown } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "NotReadableError":
    case "AbortError":
      return "in-use";
    default:
      return "unknown";
  }
}

// Loudness from an AnalyserNode's time-domain bytes (128 = silence), as 0..1.
// RMS, scaled so ordinary speech fills most of the bar rather than a sliver:
// a meter that barely moves for a normal voice reads as "my mic is broken".
export const LEVEL_GAIN = 4;

export function levelFromTimeDomain(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * LEVEL_GAIN);
}

export type DeviceLike = { deviceId: string; kind: string; label: string };

// The devices of one kind worth offering: real ids only (a browser that has
// not been granted permission lists placeholders with empty ids), and the
// "default" alias dropped when it merely duplicates a listed device, so a
// one-microphone laptop shows no picker at all.
export function devicesOfKind(devices: DeviceLike[], kind: MediaDeviceKind): DeviceLike[] {
  const real = devices.filter((d) => d.kind === kind && d.deviceId !== "");
  const named = real.filter((d) => d.deviceId !== "default");
  return named.length > 0 ? named : real;
}
