import { describe, expect, it } from "vitest";
import { isOpenedFor, widenOpenedFor } from "@/lib/materials/record-use";

describe("widenOpenedFor", () => {
  it("keeps the audience when a re-open matches it", () => {
    expect(widenOpenedFor("teacher", "teacher")).toBe("teacher");
    expect(widenOpenedFor("both", "both")).toBe("both");
  });

  // Opened once for herself and once for the student means it ended up in
  // front of both, whichever order that happened in.
  it("widens to both when a re-open has a different audience", () => {
    expect(widenOpenedFor("teacher", "student")).toBe("both");
    expect(widenOpenedFor("student", "teacher")).toBe("both");
  });

  it("never narrows an already-both record", () => {
    expect(widenOpenedFor("both", "teacher")).toBe("both");
    expect(widenOpenedFor("both", "student")).toBe("both");
  });
});

describe("isOpenedFor", () => {
  it("accepts the three known audiences", () => {
    expect(isOpenedFor("teacher")).toBe(true);
    expect(isOpenedFor("student")).toBe(true);
    expect(isOpenedFor("both")).toBe(true);
  });

  it("rejects anything else, so a crafted form value falls back", () => {
    expect(isOpenedFor("admin")).toBe(false);
    expect(isOpenedFor("")).toBe(false);
  });
});
