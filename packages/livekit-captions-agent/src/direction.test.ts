import { describe, expect, it } from "vitest";
import { resolveSpeakerDirection } from "./direction";
import type { RoomConfig } from "./app-client";

const enabledConfig: RoomConfig = {
  enabled: true,
  bookingId: "b1",
  teacherId: "t1",
  studentId: "s1",
  teacherDirection: { source: "es", target: "en" },
  studentDirection: { source: "en", target: "es" },
  studentCaptionsAllowed: true,
};

describe("resolveSpeakerDirection", () => {
  it("returns null when the room isn't enabled", () => {
    expect(resolveSpeakerDirection({ enabled: false }, "t1")).toBeNull();
  });

  it("resolves the teacher's direction, addressed to the student", () => {
    expect(resolveSpeakerDirection(enabledConfig, "t1")).toEqual({
      source: "es",
      target: "en",
      listenerIdentity: "s1",
    });
  });

  it("resolves the student's direction, addressed to the teacher, when consented", () => {
    expect(resolveSpeakerDirection(enabledConfig, "s1")).toEqual({
      source: "en",
      target: "es",
      listenerIdentity: "t1",
    });
  });

  it("returns null for the student when consent hasn't been given", () => {
    const config = { ...enabledConfig, studentCaptionsAllowed: false };
    expect(resolveSpeakerDirection(config, "s1")).toBeNull();
  });

  it("returns null for an unrecognized speaker identity", () => {
    expect(resolveSpeakerDirection(enabledConfig, "captions-agent")).toBeNull();
  });
});
