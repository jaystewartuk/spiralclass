import type { StorageProvider } from "./provider";

// Class-materials signed URLs.
//
// The dispatcher owns minting on send. Cache nothing — every call mints a
// fresh URL with a 7-day TTL so a leaked link expires well before the 60-day
// storage retention window.

export const MATERIALS_BUCKET = "class-materials";
export const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function mintMaterialsSignedUrl(
  storage: StorageProvider,
  storagePath: string,
): Promise<string | null> {
  return storage.createSignedUrl(MATERIALS_BUCKET, storagePath, SIGNED_URL_TTL_SECONDS);
}

export type MaterialUrlInputs = {
  storagePath: string | null;
  linkUrl: string | null;
};

// Returns the URL the recipient should use, in priority order:
//   1. signed URL minted from storage_path (file attachments)
//   2. linkUrl (URL-only attachments — never go through Storage)
export async function pickMaterialsUrl(
  storage: StorageProvider | null,
  m: MaterialUrlInputs,
): Promise<string | null> {
  if (m.storagePath && storage) {
    const signed = await mintMaterialsSignedUrl(storage, m.storagePath);
    if (signed) return signed;
  }
  return m.linkUrl ?? null;
}
