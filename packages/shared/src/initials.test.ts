import { describe, expect, it } from "vitest";
import { initialsFrom } from "./initials";

describe("initialsFrom", () => {
  it("uses first + last token for multi-token names", () => {
    expect(initialsFrom("María José")).toBe("MJ");
    expect(initialsFrom("Alicia Moreno")).toBe("AM");
  });

  it("uses a single letter for a single token (not two)", () => {
    expect(initialsFrom("Alba")).toBe("A");
  });

  it("splits on any non-alphanumeric run", () => {
    expect(initialsFrom("maria.jose")).toBe("MJ");
    expect(initialsFrom("maria_jose")).toBe("MJ");
  });

  it("falls back to the email local-part when no name", () => {
    expect(initialsFrom(null, "alicia.moreno@example.mx")).toBe("AM");
    expect(initialsFrom("", "alba@example.mx")).toBe("A");
  });

  it("returns ? when there is nothing to work with", () => {
    expect(initialsFrom(null)).toBe("?");
    expect(initialsFrom("   ")).toBe("?");
  });
});
