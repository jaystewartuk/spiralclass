import { describe, expect, it, vi } from "vitest";
import { UtteranceTiming } from "./log";

describe("UtteranceTiming", () => {
  it("defaults startAt to now, so the first mark reads ~0ms (old behavior when no real timestamp is known)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const timing = new UtteranceTiming("room-1");
    timing.mark("final");
    timing.done();
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged["start->finalMs"]).toBeGreaterThanOrEqual(0);
    expect(logged["start->finalMs"]).toBeLessThan(50);
    spy.mockRestore();
  });

  it("uses an explicit startAt as the baseline, so the first mark reflects real elapsed time", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const startAt = Date.now() - 700; // speech supposedly ended 700ms ago
    const timing = new UtteranceTiming("room-1", startAt);
    timing.mark("final");
    timing.done();
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    // Allow slack for real test execution time between startAt and mark().
    expect(logged["start->finalMs"]).toBeGreaterThanOrEqual(690);
    expect(logged["start->finalMs"]).toBeLessThan(800);
    spy.mockRestore();
  });

  it("computes deltas between every consecutive pair of marks, and totalMs end-to-end", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const startAt = 1_000;
    const timing = new UtteranceTiming("room-1", startAt);
    vi.spyOn(Date, "now").mockReturnValueOnce(1_500).mockReturnValueOnce(1_600);
    timing.mark("final");
    timing.mark("translated");
    timing.done();
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "utterance_timing",
      room: "room-1",
      totalMs: 600,
      "start->finalMs": 500,
      "final->translatedMs": 100,
    });
    spy.mockRestore();
    vi.restoreAllMocks();
  });
});
