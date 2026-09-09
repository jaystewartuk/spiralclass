import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cookieStore = { value: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "reading" && cookieStore.value ? { value: cookieStore.value } : undefined,
  }),
}));

const {
  READING_DEFAULTS,
  READING_SCALES,
  READING_SPACING,
  decodeReading,
  encodeReading,
  readingStyle,
} = await import("@/lib/reading");
const { getReadingPreferences } = await import("@/lib/reading-server");

/**
 * Reading preferences (D-140).
 *
 * The decode path is the one that matters most here. It runs on every server
 * render, from a cookie any client can set to anything, and its output goes
 * straight into the `<html>` style attribute — so a value it fails to reject is
 * a value that lays out the whole page. Every test below is really asking the
 * same question: does a bad cookie still produce a readable page?
 */
describe("reading preferences", () => {
  describe("decode", () => {
    it("returns the defaults when there is no cookie", () => {
      expect(decodeReading(undefined)).toEqual(READING_DEFAULTS);
      expect(decodeReading("")).toEqual(READING_DEFAULTS);
    });

    it("round-trips a valid preference", () => {
      const prefs = { scale: READING_SCALES[2], spacing: 2 as const, tint: true };
      expect(decodeReading(encodeReading(prefs))).toEqual(prefs);
    });

    it("rejects a scale that is not an offered step", () => {
      // Not merely clamped to a range: an arbitrary multiplier from a
      // hand-edited cookie would break every layout, and no UI can produce it.
      expect(decodeReading("4|0|0").scale).toBe(READING_DEFAULTS.scale);
      expect(decodeReading("0|0|0").scale).toBe(READING_DEFAULTS.scale);
      expect(decodeReading("-1|0|0").scale).toBe(READING_DEFAULTS.scale);
    });

    it("rejects a spacing step outside the three that exist", () => {
      expect(decodeReading("1|9|0").spacing).toBe(0);
      expect(decodeReading("1|-1|0").spacing).toBe(0);
    });

    it("survives a malformed cookie rather than throwing", () => {
      // The failure that must not happen: an exception here is an unrenderable
      // page, which is far worse than ignoring a preference.
      for (const junk of ["", "|||", "abc", "1", "1|", "NaN|NaN|NaN", "1|0|0|extra"]) {
        expect(() => decodeReading(junk)).not.toThrow();
        const prefs = decodeReading(junk);
        expect(READING_SCALES).toContain(prefs.scale);
        expect([0, 1, 2]).toContain(prefs.spacing);
        expect(typeof prefs.tint).toBe("boolean");
      }
    });

    it("treats any tint value but 1 as off", () => {
      expect(decodeReading("1|0|1").tint).toBe(true);
      expect(decodeReading("1|0|0").tint).toBe(false);
      expect(decodeReading("1|0|yes").tint).toBe(false);
    });
  });

  describe("style", () => {
    it("emits every custom property the stylesheet reads", () => {
      // If one of these stops being emitted the CSS silently falls back to its
      // default and the reader's setting is quietly ignored.
      const style = readingStyle(READING_DEFAULTS);
      expect(Object.keys(style).sort()).toEqual([
        "--reading-leading",
        "--reading-scale",
        "--reading-tint",
        "--reading-tracking",
        "--reading-word",
      ]);
    });

    it("moves line height with letter and word spacing", () => {
      // Opening letter spacing without opening the leading makes lines collide,
      // which is worse than leaving both alone.
      const [normal, wide, widest] = READING_SPACING;
      expect(Number(wide.leading)).toBeGreaterThan(Number(normal.leading));
      expect(Number(widest.leading)).toBeGreaterThan(Number(wide.leading));
      expect(parseFloat(widest.tracking)).toBeGreaterThan(parseFloat(wide.tracking));
      expect(parseFloat(widest.word)).toBeGreaterThan(parseFloat(wide.word));
    });

    it("turns the tint into a multiplier the gradient can use", () => {
      expect(readingStyle({ ...READING_DEFAULTS, tint: true })["--reading-tint"]).toBe("1");
      expect(readingStyle({ ...READING_DEFAULTS, tint: false })["--reading-tint"]).toBe("0");
    });

    it("expresses scale as a bare multiplier, never a pixel size", () => {
      // The root rule is calc(100% * var(--reading-scale)), so this composes
      // with the browser's own font-size setting instead of overriding it.
      const style = readingStyle({ ...READING_DEFAULTS, scale: READING_SCALES[1] });
      expect(style["--reading-scale"]).toBe(String(READING_SCALES[1]));
      expect(style["--reading-scale"]).not.toMatch(/px|rem|%/);
    });
  });

  describe("request read", () => {
    it("reads the cookie", async () => {
      cookieStore.value = encodeReading({ scale: READING_SCALES[1], spacing: 1, tint: true });
      await expect(getReadingPreferences()).resolves.toEqual({
        scale: READING_SCALES[1],
        spacing: 1,
        tint: true,
      });
    });

    it("falls back to the defaults when the cookie is absent", async () => {
      cookieStore.value = undefined;
      await expect(getReadingPreferences()).resolves.toEqual(READING_DEFAULTS);
    });
  });
});
