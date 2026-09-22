import { prisma } from "@/lib/prisma";

// The read behind the PDF-download route (/api/materials/[id]/pdf), which it
// fetch a teacher-owned library material that has a Markdown `body` to render — the
// only kind with no downloadable artifact of its own. Gated on `body` alone,
// NOT on the absence of a file/link: a unified material (notably a
// booking-scoped class-content row) can carry a body AND a file/link on the
// same row, and its body still deserves a PDF export — the attachment is
// served separately. A pure file/link material (no body) still returns null,
// so both routes 404 identically for it.
export async function findDownloadableLibraryMaterial(materialId: string, teacherId: string) {
  const material = await prisma.libraryMaterial.findFirst({
    where: { id: materialId, teacherId },
    select: { id: true, label: true, body: true },
  });
  if (!material || !material.body) return null;
  return { id: material.id, label: material.label, body: material.body };
}

// A safe, short ASCII filename stem for Content-Disposition — strips
// anything that isn't a filename-safe character (accents folded first via
// NFKD + combining-mark strip) so an emoji-laden or slash-containing title
// can't break the header or traverse a path.
//
// The `-answer-key` suffix is not decoration: a teacher who downloads both
// copies of one material otherwise ends up with two same-named files in one
// folder, and picking the wrong one to send is exactly the mistake this whole
// feature exists to prevent. It is appended AFTER the length cap so it survives
// a long title.
export function materialPdfFilename(
  label: string | null,
  options: { includeAnswerKey?: boolean } = {},
): string {
  const stem = (label ?? "material")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const suffix = options.includeAnswerKey ? "-answer-key" : "";
  return `${stem || "material"}${suffix}.pdf`;
}

// The opt-in that flips a PDF download from the student copy to the teacher's.
// Shared by both routes so web and mobile can never disagree about what counts
// as "yes" — and deliberately allow-listed rather than truthiness-checked, so a
// stray `?answers=0` or `?answers=` reads as the safe default rather than as a
// request for the answers.
export function answerKeyRequested(url: string): boolean {
  const value = new URL(url).searchParams.get("answers");
  return value === "1" || value === "true";
}
