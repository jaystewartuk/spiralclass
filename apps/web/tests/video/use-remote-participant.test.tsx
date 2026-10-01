// @vitest-environment jsdom
//
// useRemoteParticipant — keeps the camera-off placeholder and the top bar's
// name in step with the room: someone joining, turning a camera off,
// starting to speak, leaving.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { Track } from "livekit-client";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { useRemoteParticipant } = await import("@/lib/video/use-remote-participant");

type Pub = { isMuted: boolean; track?: unknown };
class FakeParticipant {
  isSpeaking = false;
  pubs = new Map<string, Pub>();
  constructor(
    public identity: string,
    public name: string,
  ) {}
  getTrackPublication(source: string) {
    return this.pubs.get(source);
  }
}

class FakeRoom {
  handlers = new Map<string, Set<() => void>>();
  remoteParticipants = new Map<string, FakeParticipant>();
  on(e: string, fn: () => void) {
    if (!this.handlers.has(e)) this.handlers.set(e, new Set());
    this.handlers.get(e)!.add(fn);
    return this;
  }
  off(e: string, fn: () => void) {
    this.handlers.get(e)?.delete(fn);
    return this;
  }
  emit(e: string) {
    for (const fn of this.handlers.get(e) ?? []) fn();
  }
}

let latest: ReturnType<typeof useRemoteParticipant>;
function Harness({ room }: { room: FakeRoom | null }) {
  latest = useRemoteParticipant(room as never);
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

describe("useRemoteParticipant", () => {
  it("is null with no room and with nobody else in it", () => {
    act(() => root.render(<Harness room={null} />));
    expect(latest).toBeNull();
    const room = new FakeRoom();
    act(() => root.render(<Harness room={room} />));
    expect(latest).toBeNull();
  });

  it("follows the other person joining, muting, speaking and leaving", () => {
    const room = new FakeRoom();
    act(() => root.render(<Harness room={room} />));

    const farid = new FakeParticipant("s1", "Farid");
    farid.pubs.set(Track.Source.Camera, { isMuted: false, track: {} });
    farid.pubs.set(Track.Source.Microphone, { isMuted: false, track: {} });
    room.remoteParticipants.set("s1", farid);
    act(() => room.emit("participantConnected"));
    expect(latest).toMatchObject({ name: "Farid", camOn: true, micOn: true, speaking: false });

    farid.pubs.set(Track.Source.Camera, { isMuted: true, track: {} });
    act(() => room.emit("trackMuted"));
    expect(latest?.camOn).toBe(false);

    farid.isSpeaking = true;
    act(() => room.emit("activeSpeakersChanged"));
    expect(latest?.speaking).toBe(true);

    room.remoteParticipants.delete("s1");
    act(() => room.emit("participantDisconnected"));
    expect(latest).toBeNull();
  });

  it("stops listening when the room goes away", () => {
    const room = new FakeRoom();
    act(() => root.render(<Harness room={room} />));
    act(() => root.render(<Harness room={null} />));
    expect([...room.handlers.values()].every((set) => set.size === 0)).toBe(true);
  });
});
