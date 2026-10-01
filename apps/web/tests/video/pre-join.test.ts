import { describe, expect, it } from "vitest";
import { devicesOfKind, levelFromTimeDomain, mediaProblemOf } from "@/lib/video/pre-join";

describe("mediaProblemOf", () => {
  it("names a blocked permission", () => {
    expect(mediaProblemOf({ name: "NotAllowedError" })).toBe("denied");
    expect(mediaProblemOf({ name: "SecurityError" })).toBe("denied");
  });

  it("names a missing device", () => {
    expect(mediaProblemOf({ name: "NotFoundError" })).toBe("no-device");
    expect(mediaProblemOf({ name: "OverconstrainedError" })).toBe("no-device");
  });

  it("names a device another app holds", () => {
    expect(mediaProblemOf({ name: "NotReadableError" })).toBe("in-use");
  });

  it("does not guess at anything else", () => {
    expect(mediaProblemOf(new Error("boom"))).toBe("unknown");
    expect(mediaProblemOf(null)).toBe("unknown");
  });
});

describe("levelFromTimeDomain", () => {
  it("is 0 for silence and for no samples", () => {
    expect(levelFromTimeDomain(new Uint8Array(256).fill(128))).toBe(0);
    expect(levelFromTimeDomain([])).toBe(0);
  });

  it("rises with loudness and caps at 1", () => {
    const quiet = levelFromTimeDomain(Array.from({ length: 256 }, (_, i) => (i % 2 ? 133 : 123)));
    const loud = levelFromTimeDomain(Array.from({ length: 256 }, (_, i) => (i % 2 ? 160 : 96)));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(levelFromTimeDomain(Array.from({ length: 256 }, (_, i) => (i % 2 ? 255 : 0)))).toBe(1);
  });
});

describe("devicesOfKind", () => {
  const mic = (deviceId: string, label = deviceId) => ({ deviceId, kind: "audioinput", label });

  it("drops the default alias when real devices are listed", () => {
    expect(devicesOfKind([mic("default"), mic("abc")], "audioinput")).toEqual([mic("abc")]);
  });

  it("keeps the default when it is all there is", () => {
    expect(devicesOfKind([mic("default")], "audioinput")).toEqual([mic("default")]);
  });

  it("ignores placeholders listed before permission and other kinds", () => {
    expect(
      devicesOfKind([mic(""), { deviceId: "cam", kind: "videoinput", label: "Cam" }], "audioinput"),
    ).toEqual([]);
  });
});
