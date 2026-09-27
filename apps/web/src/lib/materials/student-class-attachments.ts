import { isImageFileName, stripAnswerKeyMarkdown } from "@spiralclass/shared";
import type { StudentMaterialKind } from "@/lib/materials/student-materials";

// One library material attached to a class, as the STUDENT's class page shows
// it (my-classes/[bookingId]).
//
// A written material — one the teacher generated or wrote in the app — is read
// in place on the page, the way the student's materials shelf already reads it.
// The class page used to link every such material straight to its PDF export,
// so a lesson meant to be read in the app opened as a download instead. The PDF
// is still offered, as a second action beside the text.
//
// `body` is the STUDENT copy: every `> [!answer]` callout cut here, before the
// row reaches the page, because the page now renders the text it used to only
// test for. Rendering the teacher's authoring copy would put the answer key on
// the student's screen (the "Show answer" toggle is presentation, not a
// boundary). A body that was nothing but an answer key comes back null, so the
// material falls back to its file or link rather than an empty reader — and
// gets no PDF link, which would render the same empty page.
export type StudentClassAttachment = {
  id: string;
  label: string | null;
  attachmentKind: StudentMaterialKind;
  body: string | null;
  isImage: boolean;
  /** The file (signed) if there is one, else the link. Never the PDF. */
  viewUrl: string | null;
  /** Each half on its own, for a written material that also carries a file or link. */
  fileUrl: string | null;
  linkUrl: string | null;
  pdfUrl: string | null;
};

export type ClassLibraryAttachmentRow = {
  libraryMaterialId: string;
  material: {
    label: string | null;
    storagePath: string | null;
    linkUrl: string | null;
    body: string | null;
  };
};

export async function studentClassAttachment(
  a: ClassLibraryAttachmentRow,
  signFile: (storagePath: string) => Promise<string | null>,
): Promise<StudentClassAttachment> {
  const { label, storagePath, linkUrl } = a.material;
  const body = stripAnswerKeyMarkdown(a.material.body) || null;
  const fileUrl = storagePath ? await signFile(storagePath) : null;
  return {
    id: a.libraryMaterialId,
    label,
    attachmentKind: body ? "content" : storagePath ? "file" : "link",
    body,
    isImage: isImageFileName(storagePath),
    viewUrl: fileUrl ?? linkUrl ?? null,
    fileUrl,
    linkUrl,
    pdfUrl: body ? `/api/materials/${a.libraryMaterialId}/pdf` : null,
  };
}
