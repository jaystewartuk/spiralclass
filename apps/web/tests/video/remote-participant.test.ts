import { describe, expect, it } from "vitest";
import {
  initialsOf,
  remoteParticipantView,
  type ParticipantLike,
} from "@/lib/video/remote-participant";

type Pub = { isMuted: boolean; track?: unknown };

function participant(over: {
  name?: string;
  speaking?: boolean;
  camera?: Pub;
  microphone?: Pub;
}): ParticipantLike {
  return {
    identity: "s1",
    name: over.name,
    isSpeaking: over.speaking ?? false,
    getTrackPublication: (source) => over[source],
  };
}

const LIVE = { isMuted: false, track: {} };

describe("remoteParticipantView", () => {
  it("is null with nobody else in the room", () => {
    expect(remoteParticipantView(undefined)).toBeNull();
  });

  it("reports a camera and microphone that are on", () => {
    expect(
      remoteParticipantView(participant({ name: "Farid", camera: LIVE, microphone: LIVE })),
    ).toEqual({
      identity: "s1",
      name: "Farid",
      initials: "F",
      camOn: true,
      micOn: true,
      speaking: false,
    });
  });

  it("treats a muted, unpublished, or not-yet-arrived camera as off", () => {
    expect(
      remoteParticipantView(participant({ camera: { isMuted: true, track: {} } }))?.camOn,
    ).toBe(false);
    expect(remoteParticipantView(participant({}))?.camOn).toBe(false);
    expect(remoteParticipantView(participant({ camera: { isMuted: false } }))?.camOn).toBe(false);
  });

  it("is speaking only while the microphone is on", () => {
    expect(remoteParticipantView(participant({ speaking: true, microphone: LIVE }))?.speaking).toBe(
      true,
    );
    expect(
      remoteParticipantView(
        participant({ speaking: true, microphone: { isMuted: true, track: {} } }),
      )?.speaking,
    ).toBe(false);
  });

  it("has no name rather than a blank one", () => {
    expect(remoteParticipantView(participant({ name: "  " }))?.name).toBeNull();
  });
});

describe("initialsOf", () => {
  it("takes the first and last words", () => {
    expect(initialsOf("María José Hernández")).toBe("MH");
    expect(initialsOf("Farid")).toBe("F");
    expect(initialsOf("  ana   laura ")).toBe("AL");
  });

  it("keeps a character that is more than one code unit whole", () => {
    expect(initialsOf("Émile 𝒜lvarez")).toBe("É𝒜");
  });

  it("says ? for no name", () => {
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf("")).toBe("?");
  });
});
