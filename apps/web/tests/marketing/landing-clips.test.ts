import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The landing page shows the product through clips recorded from the running
// app (scripts/marketing/record.mjs → public/marketing/<name>.mp4 + .jpg).
// A clip the page names but the tree does not carry is a broken player on the
// front door, and nothing else would notice: the page compiles, the catalog
// is complete, and the <video> just shows nothing. This holds the page's clip
// names to the files, and the files to a size that keeps the page light.

const WEB = resolve(__dirname, "../..");
const PAGE = resolve(WEB, "src/app/page.tsx");
const MEDIA = resolve(WEB, "public/marketing");
const RECORDER = resolve(WEB, "scripts/marketing/record.mjs");

// Generous for a 20–40s muted H.264 screen recording at CRF 27; a clip over
// this was encoded wrong, not recorded long.
const MAX_CLIP_BYTES = 1_500_000;

function clipNamesIn(src: string): string[] {
  const names = new Set<string>();
  // The tour entries (`clip: "x"`) and any FeatureClip placed directly
  // (`name="x"`).
  for (const [, name] of src.matchAll(/\bclip: "([a-z-]+)"/g)) names.add(name);
  for (const [, name] of src.matchAll(/<FeatureClip[^>]*\bname="([a-z-]+)"/gs)) names.add(name);
  return [...names];
}

describe("landing page clips", () => {
  const page = readFileSync(PAGE, "utf8");
  const names = clipNamesIn(page);

  it("the page names at least the booking clip and the tour", () => {
    expect(names).toContain("booking");
    expect(names.length).toBeGreaterThan(5);
  });

  for (const name of names) {
    it(`${name}: the recording and its poster ship under public/marketing`, () => {
      const mp4 = resolve(MEDIA, `${name}.mp4`);
      const jpg = resolve(MEDIA, `${name}.jpg`);
      expect(existsSync(mp4), `${name}.mp4 missing — run pnpm demo:record ${name}`).toBe(true);
      expect(existsSync(jpg), `${name}.jpg missing — run pnpm demo:record ${name}`).toBe(true);
      expect(statSync(mp4).size).toBeLessThan(MAX_CLIP_BYTES);
      expect(statSync(mp4).size).toBeGreaterThan(50_000);
    });

    it(`${name}: the recorder can reproduce it`, () => {
      // A clip nobody can re-record is a screen capture in disguise.
      const recorder = readFileSync(RECORDER, "utf8");
      expect(recorder).toContain(`"${name}"`);
    });
  }
});
