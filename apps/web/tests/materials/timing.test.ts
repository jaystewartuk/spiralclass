import { describe, expect, it } from "vitest";
import { materialSendTimeElapsed } from "@/lib/materials/timing";

// Class-material send timing — the one function answering both "send
// immediately on late attach?" and "visible to the student yet?" (student
// booking views).

const START = new Date("2026-06-12T15:00:00Z");
const hoursBefore = (h: number) => new Date(START.getTime() - h * 3600_000);

describe("materialSendTimeElapsed", () => {
  it("confirmation timing is always elapsed", () => {
    expect(materialSendTimeElapsed("confirmation", START, hoursBefore(24 * 30))).toBe(true);
  });

  it("t_24h attached with 30h to go is not yet elapsed (rides the reminder leg)", () => {
    expect(materialSendTimeElapsed("t_24h", START, hoursBefore(30))).toBe(false);
  });

  it("t_24h attached with 10h to go is elapsed (the 24h leg already fired)", () => {
    expect(materialSendTimeElapsed("t_24h", START, hoursBefore(10))).toBe(true);
  });

  it("t_24h at exactly 24h is elapsed (boundary inclusive)", () => {
    expect(materialSendTimeElapsed("t_24h", START, hoursBefore(24))).toBe(true);
  });

  it("t_1h flips at the one-hour mark", () => {
    expect(materialSendTimeElapsed("t_1h", START, hoursBefore(2))).toBe(false);
    expect(materialSendTimeElapsed("t_1h", START, hoursBefore(0.5))).toBe(true);
  });

  it("t_5d flips at the five-day mark", () => {
    expect(materialSendTimeElapsed("t_5d", START, hoursBefore(6 * 24))).toBe(false);
    expect(materialSendTimeElapsed("t_5d", START, hoursBefore(4 * 24))).toBe(true);
  });

  it("a class already started still counts as elapsed for every timing", () => {
    const after = new Date(START.getTime() + 3600_000);
    expect(materialSendTimeElapsed("t_24h", START, after)).toBe(true);
    expect(materialSendTimeElapsed("t_1h", START, after)).toBe(true);
  });
});
