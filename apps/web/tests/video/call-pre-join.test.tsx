// @vitest-environment jsdom
//
// The pre-join check. Pinned on what it is for: the devices are asked for
// HERE, before anyone is waiting; a refusal is explained here, not discovered
// mid-class; what the person turned off stays off when they join; and the
// preview lets go of the devices before the call takes them.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { CallPreJoin } = await import("@/components/video/call-pre-join");

function fakeStream(kinds: ("audio" | "video")[]) {
  const tracks = kinds.map((kind) => ({ kind, stop: vi.fn() }));
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  };
}

let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;
const onJoin = vi.fn();
const onBack = vi.fn();

beforeEach(() => {
  getUserMedia = vi.fn(async (c: { audio: unknown; video: unknown }) =>
    fakeStream([...(c.audio ? ["audio" as const] : []), ...(c.video ? ["video" as const] : [])]),
  );
  enumerateDevices = vi.fn(async () => [
    { deviceId: "mic-1", kind: "audioinput", label: "Built-in" },
    { deviceId: "cam-1", kind: "videoinput", label: "FaceTime" },
  ]);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia, enumerateDevices },
    configurable: true,
  });
  onJoin.mockReset();
  onBack.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<CallPreJoin onJoin={onJoin} onBack={onBack} />);
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text,
  )!;

describe("CallPreJoin", () => {
  it("asks for the camera and microphone before anyone joins", async () => {
    await render();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("joins with both on, after letting go of the preview", async () => {
    await render();
    const stream = await getUserMedia.mock.results[0].value;
    act(() => button("call.preJoinJoin").click());
    expect(onJoin).toHaveBeenCalledWith({
      mic: true,
      cam: true,
      micDeviceId: undefined,
      camDeviceId: undefined,
    });
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("keeps the microphone off when it was turned off here", async () => {
    await render();
    await act(async () => button("call.mute").click());
    act(() => button("call.preJoinJoin").click());
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ mic: false, cam: true }));
  });

  it("explains a blocked permission and joins without media", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("call.preJoinDenied");
    act(() => button("call.preJoinJoin").click());
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ mic: false, cam: false }));
  });

  it("says so on a browser with no media devices at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("call.preJoinNoDevice");
  });

  it("offers a picker only when there is a choice to make", async () => {
    await render();
    expect(container.querySelector('[aria-label="call.preJoinMicrophone"]')).toBeNull();
    enumerateDevices.mockResolvedValue([
      { deviceId: "mic-1", kind: "audioinput", label: "Built-in" },
      { deviceId: "mic-2", kind: "audioinput", label: "USB headset" },
    ]);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('[aria-label="call.preJoinMicrophone"]')).not.toBeNull();
  });

  it("wakes a suspended audio context so the meter moves, and shows the level", async () => {
    // Chrome's autoplay policy starts an AudioContext suspended until a
    // gesture, and a suspended analyser would hold the meter on a flat line.
    const resume = vi.fn(async () => {});
    class FakeAudioContext {
      state = "suspended";
      resume = resume;
      close = vi.fn(async () => {});
      createAnalyser() {
        return {
          fftSize: 512,
          getByteTimeDomainData: (a: Uint8Array) => a.forEach((_, i) => (a[i] = i % 2 ? 160 : 96)),
        };
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    let frames = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      if (frames++ < 2) setTimeout(() => cb(0), 0);
      return frames;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      await render();
      expect(resume).toHaveBeenCalled();
      const calls = resume.mock.calls.length;
      act(() => document.dispatchEvent(new Event("pointerdown")));
      expect(resume.mock.calls.length).toBeGreaterThan(calls);
      expect(Number(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"))).toBe(
        100,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("goes back without joining", async () => {
    await render();
    act(() => button("call.preJoinBack").click());
    expect(onBack).toHaveBeenCalledOnce();
    expect(onJoin).not.toHaveBeenCalled();
  });
});
