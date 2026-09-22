"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import {
  listObjects,
  signObjectUrl,
  BucketUnavailableError,
  type Listing,
} from "@/lib/storage/r2-admin";

// Fixed, synthetic Override.targetId for storage-access audit rows. The
// action is platform-scoped (no single teacher/booking target), so it uses
// targetType "system" like the UAT actions. Stable so every access lands under
// one target in /admin/audit.
const STORAGE_ACCESS_TARGET_ID = "00000000-0000-4000-8000-000000000010";

export type ListStorageState = { error: string } | { listing: Listing };
export type SignStorageState = { error: string } | { url: string };

const bucketKeySchema = z.string().min(1).max(64);
// Object keys can be deep paths (`{teacherId}/{bookingId}/file.pdf`); allow the
// full printable range but cap length and forbid the traversal token as a
// belt-and-braces measure (S3 treats keys literally, so this is purely to keep
// the surface boring).
const objectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((k) => !k.includes(".."), "invalid key");
const prefixSchema = z.string().max(1024).optional();
const tokenSchema = z.string().max(2048).optional();

// List one folder-style page of an allowlisted bucket. Read-only; listing key
// names (not content) is not itself audited — the audited event is opening an
// object's bytes (signStorageObjectAction below).
export async function listStorageAction(
  bucketKey: string,
  prefix?: string,
  continuationToken?: string,
): Promise<ListStorageState> {
  await requireAdmin("superadmin");

  const key = bucketKeySchema.safeParse(bucketKey);
  const pfx = prefixSchema.safeParse(prefix);
  const tok = tokenSchema.safeParse(continuationToken);
  if (!key.success || !pfx.success || !tok.success) return { error: "Invalid request" };

  try {
    const listing = await listObjects(key.data, pfx.data ?? "", tok.data);
    return { listing };
  } catch (err) {
    if (err instanceof BucketUnavailableError) return { error: "Bucket not available" };
    return { error: "Could not list objects" };
  }
}

// Mint a short-lived signed GET URL for a single object and RECORD the access.
// This is the sensitive event — a superadmin reading a private object's bytes —
// so it always writes an append-only audit row before returning the URL.
export async function signStorageObjectAction(
  bucketKey: string,
  objectKey: string,
): Promise<SignStorageState> {
  const actor = await requireAdmin("superadmin");

  const key = bucketKeySchema.safeParse(bucketKey);
  const obj = objectKeySchema.safeParse(objectKey);
  if (!key.success || !obj.success) return { error: "Invalid request" };

  try {
    const url = await signObjectUrl(key.data, obj.data);
    await writeOverride({
      teacherId: null,
      targetType: "system",
      targetId: STORAGE_ACCESS_TARGET_ID,
      action: "storage_object_access",
      reason: `bucket=${key.data} key=${obj.data}`,
      actor,
    });
    return { url };
  } catch (err) {
    if (err instanceof BucketUnavailableError) return { error: "Bucket not available" };
    return { error: "Could not open object" };
  }
}
