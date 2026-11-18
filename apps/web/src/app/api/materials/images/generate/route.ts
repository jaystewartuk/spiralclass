import { NextResponse } from "next/server";
import { z } from "zod";
import { createT } from "@spiralclass/shared";
import { requireApiOnboardedTeacher } from "@/lib/api/auth";
import { errorResponse, handle, readJsonBody } from "@/lib/api/route";
import { getPreferredLocale } from "@/lib/i18n";
import { generateMaterialImage } from "@/lib/materials/generate-image";
import {
  MATERIAL_IMAGE_DESCRIPTION_MAX,
  MATERIAL_IMAGE_DESCRIPTION_MIN,
  normalizeMaterialImageDescription,
} from "@/lib/materials/image-prompt";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";

// Generates one image from the teacher's description, for embedding in a
// material body from the web block editor. Answers exactly like the upload
// route beside it, `{ ok, src }`, because the editor treats the result
// exactly like an upload: one more way to get a `material-image:` src.
//
// Pro-gated on `class_content`, the same entitlement as uploading an image and
// as authoring the body it goes into.

const bodySchema = z.object({
  description: z
    .string()
    .transform(normalizeMaterialImageDescription)
    .pipe(z.string().min(MATERIAL_IMAGE_DESCRIPTION_MIN).max(MATERIAL_IMAGE_DESCRIPTION_MAX)),
});

export async function POST(req: Request): Promise<NextResponse> {
  return handle(async () => {
    const teacher = await requireApiOnboardedTeacher(req);
    const locale = await getPreferredLocale();
    const t = createT(locale);

    const gate = await gateProFeature(teacher.id, "class_content");
    if (!gate.ok) {
      return errorResponse(403, "not-pro", upgradeNudge(gate.limit, locale));
    }

    const parsed = bodySchema.safeParse(await readJsonBody(req, z.unknown()));
    if (!parsed.success) {
      return errorResponse(
        400,
        "invalid-body",
        t("material.editor.block.imageGenerate.describe", {
          min: MATERIAL_IMAGE_DESCRIPTION_MIN,
          max: MATERIAL_IMAGE_DESCRIPTION_MAX,
        }),
      );
    }

    const result = await generateMaterialImage({
      teacherId: teacher.id,
      description: parsed.data.description,
      t,
    });
    if (!result.ok) {
      const status =
        result.reason === "throttled"
          ? 429
          : result.reason === "blocked"
            ? 422
            : result.reason === "not-configured"
              ? 503
              : 502;
      return errorResponse(status, result.reason, result.message);
    }
    return NextResponse.json({ ok: true, src: result.src }, { status: 200 });
  });
}
