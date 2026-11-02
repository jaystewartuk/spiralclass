import { afterEach, describe, expect, it, vi } from "vitest";

import { mediaObjectUrl } from "./object-url";

const RASTER = ["image/png", "image/jpeg"];

describe("mediaObjectUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints a URL for a type the caller allows", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", {
      type: "image/png",
    });
    expect(mediaObjectUrl(file, RASTER)).toBe("blob:preview");
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  // Each of these is a file a browser would render as a document if its URL
  // were opened directly, so none of them may get a URL in this origin.
  it.each([
    [
      "an SVG carrying script",
      "pwn.svg",
      "image/svg+xml",
      "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(document.domain)'/>",
    ],
    ["an HTML page", "pwn.html", "text/html", "<script>alert(document.domain)</script>"],
    ["a file whose extension says nothing", "pwn", "", "<script>alert(document.domain)</script>"],
  ])("gives %s no URL", (_label, name, type, body) => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    expect(mediaObjectUrl(new File([body], name, { type }), RASTER)).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
