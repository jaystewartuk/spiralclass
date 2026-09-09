import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentTeacher = vi.fn(async () => null as { id: string } | null);
vi.mock("@/lib/auth", () => ({
  getCurrentTeacher: () => getCurrentTeacher(),
}));

const findDownloadableLibraryMaterial = vi.fn(
  async (..._: unknown[]) => null as { id: string; label: string | null; body: string } | null,
);
vi.mock("@/lib/materials/library-pdf", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/materials/library-pdf")>();
  return {
    // `answerKeyRequested` stays REAL: the point of these cases is that the
    // route reads the query param, and a stubbed parser would test nothing.
    answerKeyRequested: actual.answerKeyRequested,
    findDownloadableLibraryMaterial: (...a: unknown[]) => findDownloadableLibraryMaterial(...a),
    materialPdfFilename: (label: string | null, options?: { includeAnswerKey?: boolean }) =>
      `${label ?? "material"}${options?.includeAnswerKey ? "-answer-key" : ""}.pdf`,
  };
});

const renderMaterialPdfBuffer = vi.fn(async (..._: unknown[]) => Buffer.from("%PDF-fake"));
vi.mock("@/lib/pdf/material-pdf", () => ({
  renderMaterialPdfBuffer: (...a: unknown[]) => renderMaterialPdfBuffer(...a),
}));

import { GET } from "@/app/api/materials/[id]/pdf/route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/materials/[id]/pdf", () => {
  it("401s when there's no teacher session", async () => {
    getCurrentTeacher.mockResolvedValue(null);
    const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));
    expect(res.status).toBe(401);
    expect(findDownloadableLibraryMaterial).not.toHaveBeenCalled();
  });

  it("404s when the material doesn't exist, isn't the teacher's, or isn't content", async () => {
    getCurrentTeacher.mockResolvedValue({ id: "t1" });
    findDownloadableLibraryMaterial.mockResolvedValue(null);
    const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));
    expect(res.status).toBe(404);
    expect(renderMaterialPdfBuffer).not.toHaveBeenCalled();
  });

  it("returns the PDF with attachment headers on success", async () => {
    getCurrentTeacher.mockResolvedValue({ id: "t1" });
    findDownloadableLibraryMaterial.mockResolvedValue({ id: "m1", label: "Lesson 1", body: "Hi." });
    const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Lesson 1.pdf"');
    expect(findDownloadableLibraryMaterial).toHaveBeenCalledWith("m1", "t1");
    expect(renderMaterialPdfBuffer).toHaveBeenCalledWith({
      title: "Lesson 1",
      body: "Hi.",
      includeAnswerKey: false,
    });
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString("latin1")).toBe("%PDF-fake");
  });

  it("serves the answer-key copy under its own filename for ?answers=1", async () => {
    getCurrentTeacher.mockResolvedValue({ id: "t1" });
    findDownloadableLibraryMaterial.mockResolvedValue({ id: "m1", label: "Lesson 1", body: "Hi." });
    const res = await GET(
      new Request("https://test.local/api/materials/m1/pdf?answers=1"),
      ctx("m1"),
    );

    expect(res.status).toBe(200);
    expect(renderMaterialPdfBuffer).toHaveBeenCalledWith({
      title: "Lesson 1",
      body: "Hi.",
      includeAnswerKey: true,
    });
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Lesson 1-answer-key.pdf"',
    );
  });

  it("falls back to the student copy for a non-affirmative answers param", async () => {
    getCurrentTeacher.mockResolvedValue({ id: "t1" });
    findDownloadableLibraryMaterial.mockResolvedValue({ id: "m1", label: "Lesson 1", body: "Hi." });
    const res = await GET(
      new Request("https://test.local/api/materials/m1/pdf?answers=0"),
      ctx("m1"),
    );

    expect(res.status).toBe(200);
    expect(renderMaterialPdfBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ includeAnswerKey: false }),
    );
  });
});
