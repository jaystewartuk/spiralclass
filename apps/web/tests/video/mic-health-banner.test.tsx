// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { MicHealthBanner } from "@/components/video/mic-health-banner";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/components/locale-provider", () => ({ useT: () => (key: string) => key }));
let container: HTMLDivElement;
let root: Root;
let level: number;
const onEvent = vi.fn();
const media = { id: "mic", label: "Test microphone", enabled: true, readyState: "live" };
const track = {
  mediaStreamTrack: media,
  getRTCStatsReport: async () =>
    new Map([
      [
        "source",
        { type: "media-source", kind: "audio", trackIdentifier: "mic", audioLevel: level },
      ],
    ]),
};
const room = {
  localParticipant: { getTrackPublication: () => ({ audioTrack: track, isMuted: false }) },
  switchActiveDevice: vi.fn().mockResolvedValue(true),
} as unknown as Room;
beforeEach(() => {
  vi.useFakeTimers();
  onEvent.mockClear();
  level = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const render = async (enabled = true, remotePresent = true) => {
  await act(async () =>
    root.render(
      <MicHealthBanner
        room={room}
        enabled={enabled}
        remotePresent={remotePresent}
        onEvent={onEvent}
      />,
    ),
  );
};
const tick = async (ms = 250) => {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
};
it("shows the warning and mic picker, then clears on speech without duplicate events", async () => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "replacement", label: "Replacement" },
      ],
    },
  });
  await render();
  expect(container.textContent).toContain("call.micSilent");
  expect(onEvent).toHaveBeenCalledWith("call_mic_silent", {
    peakLevel: 0,
    secondsObserved: 0,
    deviceLabel: "Test microphone",
  });
  await act(async () => container.querySelector("button")!.click());
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "replacement";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "replacement");
  level = 0.4;
  await tick();
  expect(container.textContent).toBe("");
  await tick();
  expect(onEvent.mock.calls.filter(([name]) => name === "call_mic_silent_recovered")).toHaveLength(
    1,
  );
});
it("clears on mute and departure, and cancels polling on unmount", async () => {
  await render();
  await render(false);
  expect(container.textContent).toBe("");
  expect(onEvent).toHaveBeenCalledTimes(1);
  await render();
  await render(true, false);
  expect(container.textContent).toBe("");
  await act(async () => root.render(null));
  await tick(60_000);
  expect(onEvent).toHaveBeenCalledTimes(2);
});
it("keeps a proven microphone quiet for a minute without a warning", async () => {
  level = 0.4;
  await render();
  level = 0;
  await tick(60_000);
  expect(container.textContent).toBe("");
  expect(onEvent).not.toHaveBeenCalled();
});
