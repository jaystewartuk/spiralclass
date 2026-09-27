import { describe, expect, it, vi } from "vitest";
import {
  studentClassAttachment,
  type ClassLibraryAttachmentRow,
} from "@/lib/materials/student-class-attachments";

function row(material: Partial<ClassLibraryAttachmentRow["material"]>): ClassLibraryAttachmentRow {
  return {
    libraryMaterialId: "m1",
    material: {
      label: "Present simple",
      storagePath: null,
      linkUrl: null,
      body: null,
      ...material,
    },
  };
}

const sign = vi.fn(async (path: string) => `https://signed.example/${path}`);

describe("studentClassAttachment", () => {
  it("reads a written material in place, with its PDF as a second action", async () => {
    // The regression: the class page used to hand a generated material's PDF
    // export over as the thing the title opens.
    const a = await studentClassAttachment(row({ body: "# Present simple\n\nShe goes." }), sign);
    expect(a.attachmentKind).toBe("content");
    expect(a.body).toBe("# Present simple\n\nShe goes.");
    expect(a.viewUrl).toBeNull();
    expect(a.pdfUrl).toBe("/api/materials/m1/pdf");
  });

  it("cuts the answer key out of the body before the page can render it", async () => {
    const authoring = [
      "> [!exercise]",
      "> Complete the gap: She (go) to school.",
      "",
      "> [!answer]",
      "> goes",
      "",
      "> [!question] Why?",
      "> Third person singular.",
      ">",
      "> > [!answer]",
      "> > Because the subject is 'she'.",
    ].join("\n");
    const a = await studentClassAttachment(row({ body: authoring }), sign);
    expect(a.body).toContain("Complete the gap");
    expect(a.body).not.toContain("[!answer]");
    expect(a.body).not.toContain("goes\n");
    expect(a.body).not.toContain("Because the subject is");
  });

  it("falls back to the file when the body was nothing but an answer key", async () => {
    const a = await studentClassAttachment(
      row({ body: "> [!answer]\n> goes", storagePath: "t1/sheet.pdf" }),
      sign,
    );
    expect(a.body).toBeNull();
    expect(a.attachmentKind).toBe("file");
    expect(a.viewUrl).toBe("https://signed.example/t1/sheet.pdf");
    expect(a.pdfUrl).toBeNull();
  });

  it("keeps both halves of a written material that also carries a file and a link", async () => {
    const a = await studentClassAttachment(
      row({ body: "Read this.", storagePath: "t1/photo.png", linkUrl: "https://example.com/v" }),
      sign,
    );
    expect(a.attachmentKind).toBe("content");
    expect(a.fileUrl).toBe("https://signed.example/t1/photo.png");
    expect(a.linkUrl).toBe("https://example.com/v");
    expect(a.isImage).toBe(true);
  });

  it("opens a file material at its signed URL, never the PDF route", async () => {
    const a = await studentClassAttachment(row({ storagePath: "t1/sheet.pdf" }), sign);
    expect(a.attachmentKind).toBe("file");
    expect(a.viewUrl).toBe("https://signed.example/t1/sheet.pdf");
    expect(a.pdfUrl).toBeNull();
    expect(a.isImage).toBe(false);
  });

  it("opens a link material at its link", async () => {
    const a = await studentClassAttachment(row({ linkUrl: "https://example.com/v" }), sign);
    expect(a.attachmentKind).toBe("link");
    expect(a.viewUrl).toBe("https://example.com/v");
    expect(a.fileUrl).toBeNull();
  });

  it("falls back to the link when the file cannot be signed", async () => {
    const a = await studentClassAttachment(
      row({ storagePath: "t1/gone.pdf", linkUrl: "https://example.com/v" }),
      async () => null,
    );
    expect(a.viewUrl).toBe("https://example.com/v");
  });
});
