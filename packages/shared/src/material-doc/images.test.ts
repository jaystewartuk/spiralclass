import { describe, expect, it } from "vitest";

import {
  collectMaterialImageKeys,
  MATERIAL_IMAGE_SCHEME,
  materialImageExtension,
  materialImageKey,
  materialImageOwner,
  materialImageSrc,
  materialImageStoragePath,
  resolveMaterialImageSrc,
  sanitizeImageAlt,
  sanitizeImageSrc,
} from "./images";
import { parseMaterialDoc } from "./parse";

describe("materialImageStoragePath", () => {
  it("files an image under the teacher's library prefix", () => {
    expect(materialImageStoragePath("teacher-1", "1712-abcd", "png")).toBe(
      "teacher-1/library/images/1712-abcd.png",
    );
  });

  // The purge job skips `${teacherId}/library/...`; an image outside that
  // prefix would be swept away while the body still references it.
  it("stays inside the purge-exempt library prefix", () => {
    const path = materialImageStoragePath("t", "u", "jpg");
    expect(path.startsWith("t/library/")).toBe(true);
  });
});

describe("materialImageOwner", () => {
  it("reads the teacher id back out of a key", () => {
    expect(materialImageOwner("teacher-1/library/images/x.png")).toBe("teacher-1");
  });

  it("rejects a key that isn't shaped like a material image path", () => {
    expect(materialImageOwner("teacher-1/library/1712-notes.pdf")).toBeNull();
    expect(materialImageOwner("teacher-1/booking-9/images/x.png")).toBeNull();
    expect(materialImageOwner("x.png")).toBeNull();
    expect(materialImageOwner("")).toBeNull();
  });
});

describe("materialImageKey", () => {
  it("unwraps the scheme", () => {
    expect(materialImageKey("material-image:t/library/images/a.png")).toBe(
      "t/library/images/a.png",
    );
  });

  it("round-trips with materialImageSrc", () => {
    const key = "t/library/images/a.png";
    expect(materialImageKey(materialImageSrc(key))).toBe(key);
  });

  it("is not fooled by a URL or another scheme", () => {
    expect(materialImageKey("https://example.com/a.png")).toBeNull();
    expect(materialImageKey("data:image/png;base64,AAAA")).toBeNull();
  });

  // A hand-edited body must not be able to address an object outside the
  // images tree by writing a traversal into the key.
  it("rejects path traversal and absolute keys", () => {
    expect(materialImageKey("material-image:../../secrets/a.png")).toBeNull();
    expect(materialImageKey("material-image:/etc/passwd")).toBeNull();
    expect(materialImageKey("material-image:t\\library\\a.png")).toBeNull();
    expect(materialImageKey("material-image:")).toBeNull();
  });
});

describe("resolveMaterialImageSrc", () => {
  it("classifies a stored image", () => {
    expect(resolveMaterialImageSrc("material-image:t/library/images/a.png")).toEqual({
      kind: "stored",
      key: "t/library/images/a.png",
    });
  });

  it("allows external https", () => {
    expect(resolveMaterialImageSrc("https://cdn.example.com/a.png")).toEqual({
      kind: "external",
      url: "https://cdn.example.com/a.png",
    });
  });

  // The allow-list is the renderers' sink guard — the same discipline link
  // hrefs already get. Everything outside it renders as alt text.
  it.each([
    "http://example.com/a.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "//example.com/a.png",
    "",
    "   ",
  ])("rejects %j", (src) => {
    expect(resolveMaterialImageSrc(src)).toBeNull();
  });
});

describe("materialImageExtension", () => {
  it("maps accepted upload types", () => {
    expect(materialImageExtension("image/png")).toBe("png");
    expect(materialImageExtension("IMAGE/JPEG")).toBe("jpg");
  });

  it("rejects anything else", () => {
    expect(materialImageExtension("application/pdf")).toBeNull();
    expect(materialImageExtension("image/svg+xml")).toBeNull();
  });
});

describe("sanitizeImageAlt / sanitizeImageSrc", () => {
  it("keeps alt text on one line and free of brackets", () => {
    expect(sanitizeImageAlt("a [tricky] alt\ntext")).toBe("a tricky alt text");
  });

  it("strips whitespace and parens out of a src", () => {
    expect(sanitizeImageSrc("  https://x/a (1).png ")).toBe("https://x/a1.png");
  });
});

describe("collectMaterialImageKeys", () => {
  it("finds stored images at every nesting depth, once each", () => {
    const doc = parseMaterialDoc(
      [
        "![top](material-image:t/library/images/a.png)",
        "",
        "> [!example] Look",
        ">",
        "> ![in a callout](material-image:t/library/images/b.png)",
        "",
        "- item",
        "",
        "  ![in a list](material-image:t/library/images/c.png)",
        "",
        "![dupe](material-image:t/library/images/a.png)",
        "",
        "![external](https://cdn.example.com/d.png)",
      ].join("\n"),
    );

    expect(collectMaterialImageKeys(doc)).toEqual([
      "t/library/images/a.png",
      "t/library/images/b.png",
      "t/library/images/c.png",
    ]);
  });

  it("returns nothing for a body with no images", () => {
    expect(collectMaterialImageKeys(parseMaterialDoc("# Just words"))).toEqual([]);
  });

  it("accepts a bare block array as well as a doc", () => {
    const doc = parseMaterialDoc("![a](material-image:t/library/images/a.png)");
    expect(collectMaterialImageKeys(doc.blocks)).toEqual(["t/library/images/a.png"]);
  });
});

describe("MATERIAL_IMAGE_SCHEME", () => {
  // The scheme is written into stored bodies; changing it would orphan every
  // image already embedded in a material.
  it("is stable", () => {
    expect(MATERIAL_IMAGE_SCHEME).toBe("material-image:");
  });
});
