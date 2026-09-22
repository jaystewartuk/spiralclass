import { describe, expect, it } from "vitest";
import { captionedIdentities, isTeacher } from "./captions-toggle";
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

describe("isTeacher", () => {
  it("is true only for the room's teacherId", () => {
    expect(isTeacher(enabledConfig, "t1")).toBe(true);
    expect(isTeacher(enabledConfig, "s1")).toBe(false);
    expect(isTeacher(enabledConfig, "captions-agent")).toBe(false);
  });

  it("is false for anyone when the room isn't enabled", () => {
    expect(isTeacher({ enabled: false }, "t1")).toBe(false);
  });
});

describe("captionedIdentities", () => {
  it("returns both parties when the room is enabled", () => {
    expect(captionedIdentities(enabledConfig)).toEqual(["t1", "s1"]);
  });

  it("returns nothing when the room isn't enabled", () => {
    expect(captionedIdentities({ enabled: false })).toEqual([]);
  });
});
