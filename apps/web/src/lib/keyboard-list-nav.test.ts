import { describe, expect, it } from "vitest";
import { stepActiveIndex } from "./keyboard-list-nav";

describe("stepActiveIndex", () => {
  it("moves down and clamps at the last item", () => {
    expect(stepActiveIndex(0, "ArrowDown", 3)).toBe(1);
    expect(stepActiveIndex(2, "ArrowDown", 3)).toBe(2);
  });

  it("moves up and clamps at the first item", () => {
    expect(stepActiveIndex(2, "ArrowUp", 3)).toBe(1);
    expect(stepActiveIndex(0, "ArrowUp", 3)).toBe(0);
  });

  it("Home/End jump to the first/last item", () => {
    expect(stepActiveIndex(1, "Home", 5)).toBe(0);
    expect(stepActiveIndex(1, "End", 5)).toBe(4);
  });

  it("an unknown key clamps the current index into range instead of moving it", () => {
    expect(stepActiveIndex(1, "Tab", 5)).toBe(1);
    expect(stepActiveIndex(10, "Tab", 5)).toBe(4);
    expect(stepActiveIndex(-1, "Tab", 5)).toBe(0);
  });

  it("an empty list always resolves to 0", () => {
    expect(stepActiveIndex(3, "ArrowDown", 0)).toBe(0);
    expect(stepActiveIndex(0, "Home", 0)).toBe(0);
  });
});
