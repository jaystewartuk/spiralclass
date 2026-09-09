import { describe, expect, it } from "vitest";
import { materialKindOf } from "./materials-kind";

describe("materialKindOf", () => {
  it("puts a body first, whatever else the row carries", () => {
    expect(materialKindOf({ body: "# Hi" })).toBe("written");
    expect(
      materialKindOf({ body: "# Hi", storagePath: "t/1-a.pdf", linkUrl: "https://x.test" }),
    ).toBe("written");
  });

  it("falls to the file when there is no body", () => {
    expect(materialKindOf({ storagePath: "t/1-a.pdf" })).toBe("file");
    expect(
      materialKindOf({ body: null, storagePath: "t/1-a.pdf", linkUrl: "https://x.test" }),
    ).toBe("file");
  });

  it("falls to the link last", () => {
    expect(materialKindOf({ linkUrl: "https://x.test" })).toBe("link");
  });

  it("treats an empty body as no body — an empty string is not content", () => {
    expect(materialKindOf({ body: "", storagePath: "t/1-a.pdf" })).toBe("file");
  });

  it("buckets a row with nothing at all as a link, matching the type filter", () => {
    // typeWhere("link") is `body: null, storagePath: null` — no linkUrl clause
    // — so this is the chip such a row is actually findable under.
    expect(materialKindOf({})).toBe("link");
  });
});
