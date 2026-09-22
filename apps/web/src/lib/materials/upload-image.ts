import { MATERIAL_IMAGE_CONTENT_TYPES } from "@spiralclass/shared";

// Client-side half of the embedded-image upload: POST the file to
// /api/materials/images and hand back the `material-image:` src the block
// editor writes into the document. Kept out of the component so the two web
// call sites (the add-block chip and the replace-image button) share one
// contract, and so the component stays about UI state.

/** The `accept` attribute for a material-image file input, derived from the
 * types the server actually accepts — so the picker and the validator can't
 * disagree about what a teacher is allowed to choose. */
export const MATERIAL_IMAGE_ACCEPT = Object.keys(MATERIAL_IMAGE_CONTENT_TYPES).join(",");

export type UploadedImage = { src: string } | { error: string };

export async function uploadMaterialImageFile(
  file: File,
  fallbackError: string,
): Promise<UploadedImage> {
  const body = new FormData();
  body.append("file", file);

  try {
    const res = await fetch("/api/materials/images", { method: "POST", body });
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      src?: string;
      message?: string;
    } | null;

    if (!res.ok || !payload?.ok || !payload.src) {
      // The server's message is already localized and specific ("larger than
      // 8 MB", the Pro nudge), so it wins over the generic caller-supplied
      // fallback whenever there is one.
      return { error: payload?.message ?? fallbackError };
    }
    return { src: payload.src };
  } catch {
    return { error: fallbackError };
  }
}
