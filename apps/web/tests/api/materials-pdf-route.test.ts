import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthUser = vi.fn(async () => ({ id: "u1" }) as { id: string } | null);
const getCurrentTeacher = vi.fn(async () => null as { id: string } | null);
vi.mock("@/lib/auth", () => ({
  getAuthUser: () => getAuthUser(),
  getCurrentTeacher: () => getCurrentTeacher(),
}));

const studentFindFirst = vi.fn(async (..._: unknown[]) => null as Record<string, unknown> | null);
vi.mock("@/lib/prisma", () => ({
  prisma: { student: { findFirst: (...a: unknown[]) => studentFindFirst(...a) } },
}));

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: async (s: { id: string }) => [s.id, "s-sibling"],
}));

type Material = { id: string; label: string | null; body: string };
const findDownloadableLibraryMaterial = vi.fn(async (..._: unknown[]) => null as Material | null);
const findStudentDownloadableLibraryMaterial = vi.fn(
  async (..._: unknown[]) => null as Material | null,
);
vi.mock("@/lib/materials/library-pdf", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/materials/library-pdf")>();
  return {
    // `answerKeyRequested` stays REAL: the point of these cases is that the
    // route reads the query param, and a stubbed parser would test nothing.
    answerKeyRequested: actual.answerKeyRequested,
    findDownloadableLibraryMaterial: (...a: unknown[]) => findDownloadableLibraryMaterial(...a),
    findStudentDownloadableLibraryMaterial: (...a: unknown[]) =>
      findStudentDownloadableLibraryMaterial(...a),
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
  getAuthUser.mockResolvedValue({ id: "u1" });
  getCurrentTeacher.mockResolvedValue(null);
  studentFindFirst.mockResolvedValue(null);
  findDownloadableLibraryMaterial.mockResolvedValue(null);
  findStudentDownloadableLibraryMaterial.mockResolvedValue(null);
});

describe("GET /api/materials/[id]/pdf", () => {
  it("401s when there's no session at all", async () => {
    getAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));
    expect(res.status).toBe(401);
    expect(findDownloadableLibraryMaterial).not.toHaveBeenCalled();
    expect(findStudentDownloadableLibraryMaterial).not.toHaveBeenCalled();
  });

  it("404s a signed-in user who is neither a teacher nor a student", async () => {
    const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));
    expect(res.status).toBe(404);
    expect(renderMaterialPdfBuffer).not.toHaveBeenCalled();
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

  // The regression: a student's class page links every sent content material
  // here, and the route used to answer only teachers — so the student got a
  // bare {"ok":false,"reason":"no-session"} instead of the PDF.
  describe("as a student", () => {
    beforeEach(() => {
      studentFindFirst.mockResolvedValue({ id: "s1", email: "ana@example.com" });
    });

    it("serves the PDF of a material sent on one of their classes", async () => {
      findStudentDownloadableLibraryMaterial.mockResolvedValue({
        id: "m1",
        label: "Lesson 1",
        body: "Hi.",
      });
      const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Lesson 1.pdf"');
      expect(studentFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { authUserId: "u1", disabledAt: null } }),
      );
      expect(findStudentDownloadableLibraryMaterial).toHaveBeenCalledWith(
        "m1",
        ["s1", "s-sibling"],
        expect.any(Date),
      );
      expect(findDownloadableLibraryMaterial).not.toHaveBeenCalled();
    });

    it("never serves the answer key, whatever the URL asks for", async () => {
      findStudentDownloadableLibraryMaterial.mockResolvedValue({
        id: "m1",
        label: "Lesson 1",
        body: "Hi.",
      });
      const res = await GET(
        new Request("https://test.local/api/materials/m1/pdf?answers=1"),
        ctx("m1"),
      );

      expect(res.status).toBe(200);
      expect(renderMaterialPdfBuffer).toHaveBeenCalledWith(
        expect.objectContaining({ includeAnswerKey: false }),
      );
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Lesson 1.pdf"');
    });

    it("404s a material not attached to, or not yet sent on, any of their classes", async () => {
      const res = await GET(new Request("https://test.local/api/materials/m1/pdf"), ctx("m1"));
      expect(res.status).toBe(404);
      expect(renderMaterialPdfBuffer).not.toHaveBeenCalled();
    });

    it("falls through to the student check for a teacher who doesn't own it", async () => {
      getCurrentTeacher.mockResolvedValue({ id: "u1" });
      findStudentDownloadableLibraryMaterial.mockResolvedValue({
        id: "m1",
        label: "Lesson 1",
        body: "Hi.",
      });
      const res = await GET(
        new Request("https://test.local/api/materials/m1/pdf?answers=1"),
        ctx("m1"),
      );

      expect(res.status).toBe(200);
      expect(findDownloadableLibraryMaterial).toHaveBeenCalledWith("m1", "u1");
      expect(renderMaterialPdfBuffer).toHaveBeenCalledWith(
        expect.objectContaining({ includeAnswerKey: false }),
      );
    });
  });
});
