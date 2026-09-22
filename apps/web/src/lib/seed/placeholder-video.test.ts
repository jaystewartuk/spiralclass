import { describe, it, expect } from "vitest";
import { SEED_VIDEO_CONTENT_TYPE, seedPlaceholderVideoMp4 } from "./placeholder-video";
import { ALLOWED_VIDEO_TYPES, MAX_VIDEO_BYTES } from "@/lib/storage/teacher-video";

// Walks the top-level MP4 box structure: each box is a big-endian uint32 size
// followed by a 4-character type.
function topLevelBoxes(buf: Buffer): string[] {
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    boxes.push(buf.toString("latin1", offset + 4, offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return boxes;
}

describe("seedPlaceholderVideoMp4", () => {
  it("decodes to a real MP4", () => {
    const mp4 = seedPlaceholderVideoMp4();
    expect(mp4.toString("latin1", 4, 8)).toBe("ftyp");
    expect(topLevelBoxes(mp4)).toContain("mdat");
  });

  it("is faststart — moov ahead of mdat, so the card decodes a first frame", () => {
    const boxes = topLevelBoxes(seedPlaceholderVideoMp4());
    expect(boxes.indexOf("moov")).toBeGreaterThan(-1);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
  });

  it("declares a content type the bucket actually allows, under the size cap", () => {
    expect(Object.keys(ALLOWED_VIDEO_TYPES)).toContain(SEED_VIDEO_CONTENT_TYPE);
    expect(seedPlaceholderVideoMp4().byteLength).toBeLessThan(MAX_VIDEO_BYTES);
  });

  it("caches, returning the same buffer rather than re-decoding per teacher", () => {
    expect(seedPlaceholderVideoMp4()).toBe(seedPlaceholderVideoMp4());
  });
});
