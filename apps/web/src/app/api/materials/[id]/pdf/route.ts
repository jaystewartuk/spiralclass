import { NextResponse } from "next/server";
import { getCurrentTeacher } from "@/lib/auth";
import {
  answerKeyRequested,
  findDownloadableLibraryMaterial,
  materialPdfFilename,
} from "@/lib/materials/library-pdf";
import { renderMaterialPdfBuffer } from "@/lib/pdf/material-pdf";

// Downloads a native "content" library material (Settings → Materials) as a
// PDF — title + rendered Markdown body. Cookie-authed like the rest of the
// web dashboard (getCurrentTeacher, not requireOnboardedTeacher: a
// redirect() from an unauthenticated <a href> download would be the wrong
// response shape for this route). File/link materials already have a
// downloadable/viewable URL and aren't served here — 404 either way so a
// stale link can't distinguish "not yours" from "not a content item".
//
// `?answers=1` opts into the teacher copy, which keeps the `[!answer]` blocks.
// Without it the student copy is served — see material-pdf.tsx for why that is
// the default and not the other way round. The teacher gate above is what makes
// the opt-in safe to expose as a query param at all: this material belongs to
// the signed-in teacher, so there is nobody to leak the answers to.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher) {
    return NextResponse.json({ ok: false, reason: "no-session" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const material = await findDownloadableLibraryMaterial(id, teacher.id);
  if (!material) {
    return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  }

  const includeAnswerKey = answerKeyRequested(req.url);
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
