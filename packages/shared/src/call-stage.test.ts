import { describe, expect, it } from "vitest";
import { resolveCallStage } from "./call-stage";

describe("resolveCallStage", () => {
  it("shows the remote full-stage when present and no material is open", () => {
    expect(resolveCallStage({ materialOpen: false, hasRemote: true })).toEqual({
      main: "remote",
      remotePip: false,
    });
  });

  it("shows the waiting state when alone and no material is open", () => {
    expect(resolveCallStage({ materialOpen: false, hasRemote: false })).toEqual({
      main: "waiting",
      remotePip: false,
    });
  });

  it("keeps the remote as a PiP tile while a material is open and they're present", () => {
    // The whole point: showing material must not hide the other person — they
    // shrink to a corner tile so the teacher can still see the student.
    expect(resolveCallStage({ materialOpen: true, hasRemote: true })).toEqual({
      main: "material",
      remotePip: true,
    });
  });

  it("shows no PiP when a material is open but the other party hasn't joined", () => {
    // An empty tile would just be a black box — suppress it until there's video.
    expect(resolveCallStage({ materialOpen: true, hasRemote: false })).toEqual({
      main: "material",
      remotePip: false,
    });
  });

  it("swaps the local camera to the main stage and the remote to a PiP tile", () => {
    expect(resolveCallStage({ materialOpen: false, hasRemote: true, swapped: true })).toEqual({
      main: "local",
      remotePip: true,
    });
  });

  it("ignores swapped while alone — there is nothing to swap into", () => {
    expect(resolveCallStage({ materialOpen: false, hasRemote: false, swapped: true })).toEqual({
      main: "waiting",
      remotePip: false,
    });
  });

  it("ignores swapped while a material is open — the material always wins the stage", () => {
    expect(resolveCallStage({ materialOpen: true, hasRemote: true, swapped: true })).toEqual({
      main: "material",
      remotePip: true,
    });
  });
});
