import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn(async (..._: unknown[]) => null as Record<string, unknown> | null);
vi.mock("@/lib/prisma", () => ({
  prisma: { libraryMaterial: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

import {
  answerKeyRequested,
  findDownloadableLibraryMaterial,
  materialPdfFilename,
} from "@/lib/materials/library-pdf";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findDownloadableLibraryMaterial", () => {
  it("returns the material when it's native content (body, no file/link)", async () => {
    findFirst.mockResolvedValue({
      id: "m1",
      label: "Lesson 1",
      body: "Some **markdown**.",
    });
    const result = await findDownloadableLibraryMaterial("m1", "t1");
    expect(result).toEqual({ id: "m1", label: "Lesson 1", body: "Some **markdown**." });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m1", teacherId: "t1" } }),
    );
  });

  it("returns a unified material's body even when a file/link rides on the same row", async () => {
    // Class content (booking-scoped) can carry a body AND a file/link on one
    // row — its body still deserves a PDF export (the attachment is served
    // separately). Gated on `body` alone, so this is downloadable.
    findFirst.mockResolvedValue({
      id: "m1",
      label: "Class content",
      body: "Lesson **body**.",
    });
    const result = await findDownloadableLibraryMaterial("m1", "t1");
    expect(result).toEqual({ id: "m1", label: "Class content", body: "Lesson **body**." });
  });

  it("returns null when the material doesn't exist or isn't the teacher's", async () => {
    findFirst.mockResolvedValue(null);
    expect(await findDownloadableLibraryMaterial("missing", "t1")).toBeNull();
  });

  it("returns null for a file material (storagePath set)", async () => {
    findFirst.mockResolvedValue({
      id: "m1",
      label: "Worksheet",
      body: null,
      storagePath: "t1/library/x.pdf",
      linkUrl: null,
    });
    expect(await findDownloadableLibraryMaterial("m1", "t1")).toBeNull();
  });

  it("returns null for a link material (linkUrl set)", async () => {
    findFirst.mockResolvedValue({
      id: "m1",
      label: "External",
      body: null,
      storagePath: null,
      linkUrl: "https://example.com",
    });
    expect(await findDownloadableLibraryMaterial("m1", "t1")).toBeNull();
  });

  it("returns null when body is present but empty/null-ish", async () => {
    findFirst.mockResolvedValue({
      id: "m1",
      label: "Empty",
      body: "",
      storagePath: null,
      linkUrl: null,
    });
    expect(await findDownloadableLibraryMaterial("m1", "t1")).toBeNull();
  });
});

describe("materialPdfFilename", () => {
  it("slugifies a plain label", () => {
    expect(materialPdfFilename("Past Simple Worksheet")).toBe("Past-Simple-Worksheet.pdf");
  });

  it("falls back to 'material' when the label is null", () => {
    expect(materialPdfFilename(null)).toBe("material.pdf");
  });

  it("strips accents and unsafe characters", () => {
    expect(materialPdfFilename("Práctica: Unidad 3/4")).toBe("Practica-Unidad-34.pdf");
  });

  it("falls back to 'material' when the label has no filename-safe characters", () => {
    expect(materialPdfFilename("日本語")).toBe("material.pdf");
  });

  it("caps the stem length", () => {
    const long = "a".repeat(200);
    const result = materialPdfFilename(long);
    expect(result).toBe(`${"a".repeat(60)}.pdf`);
  });

  it("marks the answer-key copy so both downloads can coexist in one folder", () => {
    expect(materialPdfFilename("Unit 3", { includeAnswerKey: true })).toBe("Unit-3-answer-key.pdf");
  });

  it("keeps the plain name when the answer key isn't requested", () => {
    expect(materialPdfFilename("Unit 3", { includeAnswerKey: false })).toBe("Unit-3.pdf");
  });

  it("appends the answer-key suffix after the length cap, so it survives", () => {
    expect(materialPdfFilename("a".repeat(200), { includeAnswerKey: true })).toBe(
      `${"a".repeat(60)}-answer-key.pdf`,
    );
  });

  it("still marks the fallback stem", () => {
    expect(materialPdfFilename(null, { includeAnswerKey: true })).toBe("material-answer-key.pdf");
  });
});

describe("answerKeyRequested", () => {
  const url = (query: string) => `https://test.local/api/materials/m1/pdf${query}`;

  it("is false with no query at all — the student copy is the default", () => {
    expect(answerKeyRequested(url(""))).toBe(false);
  });

  it("accepts the two affirmative spellings", () => {
    expect(answerKeyRequested(url("?answers=1"))).toBe(true);
    expect(answerKeyRequested(url("?answers=true"))).toBe(true);
  });

  it("reads anything else as the safe default", () => {
    // Notably `?answers=0` and a bare `?answers`, which a truthiness check on
    // the raw param would have got backwards.
    expect(answerKeyRequested(url("?answers=0"))).toBe(false);
    expect(answerKeyRequested(url("?answers=false"))).toBe(false);
    expect(answerKeyRequested(url("?answers="))).toBe(false);
    expect(answerKeyRequested(url("?answers"))).toBe(false);
    expect(answerKeyRequested(url("?answers=yes"))).toBe(false);
    expect(answerKeyRequested(url("?other=1"))).toBe(false);
  });
});
