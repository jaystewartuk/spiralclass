import { describe, expect, it } from "vitest";
import { materialImageRoutePath } from "@spiralclass/shared";

import { imageKeyFromSegments } from "./image-serve";

// The URL builder and the route's segment decoder are inverses of each other,
// and they live in different packages (shared / web). A regression in either
// one shows up as an image that 404s only for keys containing an awkward
// character — the kind of thing nothing else would catch.
describe("imageKeyFromSegments", () => {
  it("rebuilds a plain key", () => {
    expect(imageKeyFromSegments(["t", "library", "images", "a.png"])).toBe(
      "t/library/images/a.png",
    );
  });

  it.each([
    "teacher-1/library/images/1712-abc.png",
    "teacher-1/library/images/a b.png",
    "teacher-1/library/images/a+b.png",
    "teacher-1/library/images/a%20b.png",
    "teacher-1/library/images/a#b.png",
    "teacher-1/library/images/a?b.png",
    "teacher-1/library/images/ñ.png",
  ])("round-trips %j through the route path", (key) => {
    const path = materialImageRoutePath(key);
    const segments = path.replace("/api/materials/images/", "").split("/");
    expect(imageKeyFromSegments(segments)).toBe(key);
  });

  // A `#` or `?` left unencoded would truncate the path at that character and
  // silently address a different (or no) object.
  it("encodes characters that would otherwise truncate the URL", () => {
    const path = materialImageRoutePath("t/library/images/a?b#c.png");
    expect(path).not.toContain("?");
    expect(path).not.toContain("#");
  });
});
