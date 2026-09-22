import { describe, expect, it } from "vitest";
import { initialsFrom } from "@/lib/initials";

describe("initialsFrom", () => {
  it("takes first + last initial of a multi-word name", () => {
    expect(initialsFrom("María José Pérez", null)).toBe("MP");
  });

  it("takes the first letter of a single-word name", () => {
    expect(initialsFrom("Mira", null)).toBe("M");
  });

  it("uppercases regardless of input case", () => {
    expect(initialsFrom("mira garcía", null)).toBe("MG");
  });

  it("falls back to the email local-part when name is blank", () => {
    expect(initialsFrom("   ", "jay.stewart@example.com")).toBe("JS");
    expect(initialsFrom(null, "mira@example.com")).toBe("M");
  });

  it("splits the local-part on separators and digits", () => {
    expect(initialsFrom(undefined, "maria_jose@x.com")).toBe("MJ");
    expect(initialsFrom(undefined, "jstewart@example.com")).toBe("J");
  });

  it("prefers the name over the email when both are present", () => {
    expect(initialsFrom("Bea", "zzz@example.com")).toBe("B");
  });

  it("returns a placeholder when there's nothing usable", () => {
    expect(initialsFrom(null, null)).toBe("?");
    expect(initialsFrom("", "")).toBe("?");
  });
});
