import { prisma } from "@/lib/prisma";
import { materialSendTimeElapsed } from "@/lib/materials/timing";

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

// The student half of the same route. A student reaches a content material's
// PDF from their class page, which links every visible body-bearing library
// item to /api/materials/[id]/pdf — so the route has to answer them, or the
// "Download" on their own class opens a bare `no-session` JSON error.
//
// The rule is the class page's own: the material is attached to a booking
// that belongs to this student (across their identity set — see
// lib/students/identity.ts), and its send time on that booking has elapsed.
// Anything the page would not show them, this does not serve. One material
// can sit on several of their classes with different send times, so it is
// enough for ANY one of those attachments to have been sent.
export async function findStudentDownloadableLibraryMaterial(
  materialId: string,
  studentIds: string[],
  now: Date,
) {
  if (studentIds.length === 0) return null;
  const attachments = await prisma.bookingLibraryMaterial.findMany({
    where: { libraryMaterialId: materialId, booking: { studentId: { in: studentIds } } },
    select: {
      sendTiming: true,
      booking: { select: { scheduledStart: true } },
      material: { select: { id: true, label: true, body: true } },
    },
  });
  const sent = attachments.find((a) =>
    materialSendTimeElapsed(a.sendTiming, a.booking.scheduledStart, now),
  );
  if (!sent || !sent.material.body) return null;
  return { id: sent.material.id, label: sent.material.label, body: sent.material.body };
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
