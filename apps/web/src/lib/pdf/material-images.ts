import { collectMaterialImageKeys, type MaterialDoc } from "@spiralclass/shared";
import { getStorageProvider } from "@/lib/storage/provider";
import { mintMaterialsSignedUrl } from "@/lib/storage/signed-urls";
import type { MaterialPdfImages } from "./material-doc-pdf";

// Pre-signs every stored image a material PDF is about to embed.
//
// This exists because a PDF render is the one consumer that cannot go through
// the authenticated image route: it runs server-side with no session, so it
// would be its own unauthenticated caller. Signing here instead is safe for
// the same reason the route is — the caller has ALREADY authorized the whole
// material (the PDF routes resolve it against the requesting teacher before
// rendering), so no per-image check is left to make.
//
// Failures are swallowed per key rather than failing the download: a picture
// that can't be signed drops to its caption, which still carries the exercise,
// whereas a 500 loses the teacher the whole handout minutes before class.

export async function signMaterialImages(doc: MaterialDoc): Promise<MaterialPdfImages> {
  const keys = collectMaterialImageKeys(doc);
  if (!keys.length) return {};

  const storage = getStorageProvider();
  const signed = await Promise.all(
    keys.map(async (key) => {
      const url = await mintMaterialsSignedUrl(storage, key).catch(() => null);
      return [key, url] as const;
    }),
  );

  const map: MaterialPdfImages = {};
  for (const [key, url] of signed) {
    if (url) map[key] = url;
  }
  return map;
}
