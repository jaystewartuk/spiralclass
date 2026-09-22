import { describe, expect, it } from "vitest";

import {
  fileExtensionOf,
  isImageFileName,
  isPdfFileName,
  materialFileKind,
} from "./material-file-kind";

describe("fileExtensionOf", () => {
  it("reads the extension off a storage key", () => {
    expect(fileExtensionOf("teacher-1/library/1712345-photo.PNG")).toBe("png");
  });

  it("uses the last dot, not the first", () => {
    expect(fileExtensionOf("t/library/1712-my.photo.final.jpg")).toBe("jpg");
  });

  it("ignores a query string or fragment on a signed URL", () => {
    expect(fileExtensionOf("https://r2.example.com/b/t/a.png?X-Amz-Signature=abc")).toBe("png");
    expect(fileExtensionOf("https://r2.example.com/b/t/a.webp#top")).toBe("webp");
  });

  it("has no extension for a dotless name, a dotfile, or a trailing dot", () => {
    expect(fileExtensionOf("t/library/1712-notes")).toBeNull();
    expect(fileExtensionOf(".gitignore")).toBeNull();
    expect(fileExtensionOf("t/library/trailing.")).toBeNull();
  });
});

describe("isImageFileName", () => {
  it.each(["a.jpg", "a.jpeg", "a.png", "a.webp", "a.gif", "a.avif", "a.heic", "a.heif"])(
    "previews %s inline",
    (name) => {
      expect(isImageFileName(name)).toBe(true);
    },
  );

  it("is case-insensitive", () => {
    expect(isImageFileName("t/library/1712-Vacation.JPEG")).toBe(true);
  });

  it.each(["a.pdf", "a.docx", "a.mp3", "a.zip", "a.txt", "notes"])(
    "leaves %s as a download link",
    (name) => {
      expect(isImageFileName(name)).toBe(false);
    },
  );

  // An SVG is a scriptable document, not an inert raster — rendering one
  // inline would reintroduce the HTML sink the renderers exist to avoid.
  it("never previews an SVG inline", () => {
    expect(isImageFileName("t/library/1712-diagram.svg")).toBe(false);
  });

  it("handles the absent path of a link- or content-kind material", () => {
    expect(isImageFileName(null)).toBe(false);
    expect(isImageFileName(undefined)).toBe(false);
    expect(isImageFileName("")).toBe(false);
  });
});

describe("isPdfFileName", () => {
  it("is true for a PDF, whatever the case of the extension", () => {
    expect(isPdfFileName("t/library/1712-worksheet.pdf")).toBe(true);
    expect(isPdfFileName("t/library/1712-Worksheet.PDF")).toBe(true);
  });

  it("reads through a signed URL's query string", () => {
    expect(isPdfFileName("https://r2.example.com/b/t/w.pdf?X-Amz-Signature=abc")).toBe(true);
  });

  it.each(["a.png", "a.docx", "a.pdfx", "notes", null, undefined, ""])(
    "is false for %s",
    (name) => {
      expect(isPdfFileName(name)).toBe(false);
    },
  );
});

describe("materialFileKind", () => {
  it("buckets a PDF, an image and everything else", () => {
    expect(materialFileKind("t/library/1712-worksheet.pdf")).toBe("pdf");
    expect(materialFileKind("t/library/1712-photo.png")).toBe("image");
    expect(materialFileKind("t/library/1712-slides.pptx")).toBe("other");
  });

  // The in-call viewer picks its renderer off this, so the SVG exclusion above
  // has to survive the trip: an .svg is "other", which means it opens outside
  // the call exactly as it did before and never becomes an inline document.
  it("keeps an SVG out of every inline renderer", () => {
    expect(materialFileKind("t/library/1712-diagram.svg")).toBe("other");
  });

  it("is 'other' for a material with no file at all", () => {
    expect(materialFileKind(null)).toBe("other");
    expect(materialFileKind("")).toBe("other");
  });
});
