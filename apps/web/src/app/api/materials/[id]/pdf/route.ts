import { NextResponse } from "next/server";
import { getAuthUser, getCurrentTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  answerKeyRequested,
  findDownloadableLibraryMaterial,
  findStudentDownloadableLibraryMaterial,
  materialPdfFilename,
} from "@/lib/materials/library-pdf";
import { renderMaterialPdfBuffer } from "@/lib/pdf/material-pdf";
import { studentIdentityIds } from "@/lib/students/identity";

// Downloads a native "content" library material as a PDF — title + rendered
// Markdown body. Cookie-authed like the rest of the web dashboard and the
// student portal (getAuthUser, not requireOnboardedTeacher/requireStudent: a
// redirect() from an unauthenticated <a href> download would be the wrong
// response shape for this route). File/link materials already have a
// downloadable/viewable URL and aren't served here — 404 either way so a
// stale link can't distinguish "not yours" from "not a content item".
//
// Two viewers, tried in turn:
//   * the owning teacher (Settings → Materials, her class page), and
//   * a student whose class the material is attached to and already sent —
//     their class page links here too. This route used to answer only the
//     teacher, so a student's "Download" landed on a `no-session` error.
// A teacher who is also someone else's student falls through to the student
// check when the material isn't hers.
//
// `?answers=1` opts into the teacher copy, which keeps the `[!answer]` blocks.
// Without it the student copy is served — see material-pdf.tsx for why that is
// the default and not the other way round. Only the teacher branch reads the
// param at all: this material belongs to her, so there is nobody to leak the
// answers to. A student is served the stripped copy whatever the URL says.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "no-session" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const teacher = await getCurrentTeacher();
  if (teacher) {
    const material = await findDownloadableLibraryMaterial(id, teacher.id);
    if (material) return pdfResponse(material, answerKeyRequested(req.url));
  }

  const student = await prisma.student.findFirst({
    where: { authUserId: user.id, disabledAt: null },
    select: { id: true, email: true },
  });
  if (student) {
    const material = await findStudentDownloadableLibraryMaterial(
      id,
      await studentIdentityIds(student),
      new Date(),
    );
    if (material) return pdfResponse(material, false);
  }

  return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
}

async function pdfResponse(
  material: { label: string | null; body: string },
  includeAnswerKey: boolean,
): Promise<Response> {
  const buffer = await renderMaterialPdfBuffer({
    title: material.label ?? "Material",
    body: material.body,
    includeAnswerKey,
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${materialPdfFilename(material.label, { includeAnswerKey })}"`,
      "Cache-Control": "no-store, private",
    },
  });
}
