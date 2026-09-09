import { describe, it, expect } from "vitest";
import { SEED_PHOTO_SIZE, monogramPairFor, seedPlaceholderPhotoPng } from "./placeholder-photo";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("monogramPairFor", () => {
  it("is deterministic for the same key", () => {
    expect(monogramPairFor("alicia.moreno@spiralclass.test")).toEqual(
      monogramPairFor("alicia.moreno@spiralclass.test"),
    );
  });

  it("spreads the seeded teachers across more than one pair", () => {
    const keys = [
      "Alicia Moreno",
      "Beatriz Soto",
      "Diego Márquez",
      "Elena Vargas",
      "Fernando Cruz",
      "Gabriela Reyes",
      "Hugo Ramírez",
      "Inés Navarro",
      "Jorge Medina",
      "Wendy Wise",
      "Nora Norail",
      "Paula Pagos",
      "Yuki Tanaka",
    ];
    const distinct = new Set(keys.map((k) => monogramPairFor(k).bg));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("never pairs a foreground with its own background", () => {
    for (const key of ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"]) {
      const pair = monogramPairFor(key);
      expect(pair.fg).not.toEqual(pair.bg);
    }
  });
});

describe("seedPlaceholderPhotoPng", () => {
  // The whole point of the module: the seed must produce REAL bytes to upload,
  // because a `photo_path` pointing at an object nobody put in the bucket
  // renders as a broken image (there is no 404 fallback on the read side).
  it("returns a PNG of the declared size", async () => {
    const png = await seedPlaceholderPhotoPng("Alicia Moreno", "alicia.moreno@spiralclass.test");
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    // IHDR width/height are big-endian uint32s at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBe(SEED_PHOTO_SIZE);
    expect(png.readUInt32BE(20)).toBe(SEED_PHOTO_SIZE);
  }, 30_000);

  it("tolerates a teacher with no name", async () => {
    const png = await seedPlaceholderPhotoPng(null, "nora@spiralclass.test");
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  }, 30_000);
});
