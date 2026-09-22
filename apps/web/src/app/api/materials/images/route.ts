import { NextResponse } from "next/server";
import { getCurrentTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { uploadMaterialImage } from "@/lib/storage/material-images";
import { usesEnglishCopy } from "@spiralclass/shared";

// Uploads one image for embedding in a material body, from the WEB block
// editor. Returns the `material-image:` src the editor writes into the block —
// never a URL, so the stored body stays valid after the signed URL that would
// have been minted here expires (see lib/materials/image-access.ts).
//
// Pro-gated on the same `class_content` entitlement as authoring the body this
// image goes into: an image is content authoring, and gating it separately
// would let a Free teacher fill a body she can't save anyway.
//
// A multipart POST rather than a server action: the editor uploads from the
// browser mid-edit rather than on form submit.

export async function POST(req: Request): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher) {
    return NextResponse.json({ ok: false, reason: "no-session" }, { status: 401 });
  }

  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);

  const gate = await gateProFeature(teacher.id, "class_content");
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, reason: "not-pro", message: upgradeNudge(gate.limit, locale) },
      { status: 403 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        ok: false,
        reason: "invalid-body",
        message: en ? "Choose an image to upload." : "Elige una imagen para subir.",
      },
      { status: 400 },
    );
  }

  const result = await uploadMaterialImage({ teacherId: teacher.id, file, en });
  if ("error" in result) {
    return NextResponse.json(
      { ok: false, reason: "upload-failed", message: result.error },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, src: result.ok.src }, { status: 200 });
}
