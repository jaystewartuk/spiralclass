import { describe, expect, it } from "vitest";
import {
  CAPTION_TIMING_DEFAULTS,
  captionCutPoint,
  captionRemainder,
  parseCaptionTiming,
  previewCaptionCuts,
} from "./caption-timing";

describe("parseCaptionTiming", () => {
  it("defaults to both dials off, which is the behaviour before they existed", () => {
    expect(CAPTION_TIMING_DEFAULTS).toEqual({ pauseMs: 0, maxChars: 0 });
    expect(parseCaptionTiming(null)).toEqual(CAPTION_TIMING_DEFAULTS);
    expect(parseCaptionTiming("nope")).toEqual(CAPTION_TIMING_DEFAULTS);
    expect(parseCaptionTiming({})).toEqual(CAPTION_TIMING_DEFAULTS);
  });

  it("keeps a valid setting", () => {
    expect(parseCaptionTiming({ pauseMs: 800, maxChars: 120 })).toEqual({
      pauseMs: 800,
      maxChars: 120,
    });
  });

  it("clamps into range and snaps to the step, field by field", () => {
    expect(parseCaptionTiming({ pauseMs: 50, maxChars: 9999 })).toEqual({
      pauseMs: 400,
      maxChars: 300,
    });
    expect(parseCaptionTiming({ pauseMs: 99999, maxChars: 44 })).toEqual({
      pauseMs: 3000,
      maxChars: 40,
    });
    expect(parseCaptionTiming({ pauseMs: 849, maxChars: 0 }).pauseMs).toBe(800);
  });

  it("reads zero, negative, NaN and non-numeric as off without losing the other field", () => {
    expect(parseCaptionTiming({ pauseMs: -5, maxChars: 100 })).toEqual({
      pauseMs: 0,
      maxChars: 100,
    });
    expect(parseCaptionTiming({ pauseMs: "abc", maxChars: NaN }).pauseMs).toBe(0);
    expect(parseCaptionTiming({ pauseMs: "600" }).pauseMs).toBe(600);
  });
});

describe("captionRemainder", () => {
  it("returns everything when nothing was cut", () => {
    expect(captionRemainder("", "hola que tal")).toBe("hola que tal");
  });
  it("strips an exact prefix, ignoring case", () => {
    expect(captionRemainder("Hola que", "hola que tal estás")).toBe("tal estás");
  });
  it("falls back to counting words when the recogniser revised the start", () => {
    expect(captionRemainder("hola que", "ola qué tal estás")).toBe("tal estás");
  });
  it("counts characters for unspaced scripts", () => {
    expect(captionRemainder("你好", "你好吗朋友")).toBe("吗朋友");
    expect(captionRemainder("你好", "妳好吗朋友")).toBe("吗朋友");
  });
  it("is empty when everything heard was already cut", () => {
    expect(captionRemainder("hola que tal", "hola que tal")).toBe("");
  });
});

describe("captionCutPoint", () => {
  it("waits below the limit and when the limit is off", () => {
    expect(captionCutPoint("short text", 40)).toBe(0);
    expect(captionCutPoint("x".repeat(500), 0)).toBe(0);
  });
  it("cuts before the word still being heard", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    expect(text.slice(0, captionCutPoint(text, 40))).toBe(
      "one two three four five six seven eight nine ten eleven",
    );
  });
  it("cuts at the limit where there are no spaces to cut at", () => {
    expect(captionCutPoint("你".repeat(60), 40)).toBe(40);
  });
});

describe("previewCaptionCuts", () => {
  const sample =
    "Yesterday I went to the market with my sister and we bought some tomatoes | but then it started to rain so we ran home";
  it("is one line with both dials off (the browser waits for the speaker to stop)", () => {
    expect(previewCaptionCuts(sample, CAPTION_TIMING_DEFAULTS)).toHaveLength(1);
  });
  it("cuts at a breath at least as long as the pause", () => {
    const lines = previewCaptionCuts(sample, { pauseMs: 800, maxChars: 0 });
    expect(lines).toEqual([
      "Yesterday I went to the market with my sister and we bought some tomatoes",
      "but then it started to rain so we ran home",
    ]);
    expect(previewCaptionCuts(sample, { pauseMs: 1000, maxChars: 0 })).toHaveLength(1);
  });
  it("cuts a run with no breath at the length limit and loses no words", () => {
    const lines = previewCaptionCuts(sample, { pauseMs: 0, maxChars: 50 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(sample.replace(" | ", " "));
  });
});
