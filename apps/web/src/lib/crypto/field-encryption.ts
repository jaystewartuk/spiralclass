import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { serverEnv } from "@/lib/env";

// docs/security.md — field-level encryption for
// `phoneE164` (and any future PII column whose blast radius we
// want to reduce on a partial DB compromise).
//
// The scheme:
//   * One master key, sourced from `FIELD_ENCRYPTION_KEY` (32 random
//     bytes, base64). Production stores this in Supabase Vault and
//     reads it at boot.
//   * Per-column subkeys derived via HKDF with the column name as
//     the `info` parameter. Lets us rotate one column's key without
//     touching others — bump the salt, run a backfill.
//   * Encryption: AES-256-GCM with a fresh 12-byte IV, 16-byte tag.
//     Stored format: `v1:<iv-b64>:<ciphertext-b64>:<tag-b64>`.
//   * Lookup index: a deterministic HMAC-SHA-256 hash stored in a
//     companion `_hash` column. `phoneE164` becomes
//     `phoneE164Encrypted` (bytea-ish, stored as TEXT v1:...) +
//     `phoneE164Hash` (text). The dispatcher and admin search
//     query the hash; only specific paths (notification dispatch,
//     admin detail) ever decrypt.
//
// Status: this module ships the primitives. The schema migration,
// the backfill Inngest job, and the per-read-site swap are the next
// commits. See field-level encryption for the rollout sequence.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_HASH = "sha256";

const SUBKEY_SALT_VERSION = 1;

function getMasterKey(): Buffer | null {
  const raw = serverEnv().FIELD_ENCRYPTION_KEY;
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

// Cached derived keys per column. Cheap to derive but called per
// read; cache avoids the HKDF cost in the dispatcher's hot path.
const subkeyCache = new Map<string, { encKey: Buffer; macKey: Buffer }>();

function deriveSubkeys(column: string): { encKey: Buffer; macKey: Buffer } | null {
  const cached = subkeyCache.get(column);
  if (cached) return cached;
  const master = getMasterKey();
  if (!master) return null;
  const salt = Buffer.from(`spiralclass:field-encryption:v${SUBKEY_SALT_VERSION}`);
  const encKey = Buffer.from(hkdfSync(HKDF_HASH, master, salt, `enc:${column}`, KEY_BYTES));
  const macKey = Buffer.from(hkdfSync(HKDF_HASH, master, salt, `mac:${column}`, KEY_BYTES));
  const subkeys = { encKey, macKey };
  subkeyCache.set(column, subkeys);
  return subkeys;
}

// Encrypts a string for the named column. Returns null when no master
// key is configured — callers should treat null as "store as plaintext"
// to keep the migration path additive (set the column, ship code,
// backfill, then drop the plaintext column).
export function encryptField(column: string, plaintext: string): string | null {
  const subkeys = deriveSubkeys(column);
  if (!subkeys) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", subkeys.encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

// Inverse of encryptField. Returns null on a malformed payload (caller
// should treat that as a data-integrity error and Sentry-capture it).
export function decryptField(column: string, payload: string): string | null {
  const subkeys = deriveSubkeys(column);
  if (!subkeys) return null;
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1] ?? "", "base64");
    const ciphertext = Buffer.from(parts[2] ?? "", "base64");
    const tag = Buffer.from(parts[3] ?? "", "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", subkeys.encKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

// Deterministic HMAC-SHA-256 of the plaintext, base64-encoded. Used to
// support equality-style lookups (e.g. "find the student whose phone
// matches X"). The MAC key is column-scoped so a hash collision across
// columns is not exploitable.
export function hashField(column: string, plaintext: string): string | null {
  const subkeys = deriveSubkeys(column);
  if (!subkeys) return null;
  return createHmac("sha256", subkeys.macKey).update(plaintext, "utf8").digest("base64");
}

// Test affordance: reset the cache. Real callers never need this.
export function __resetSubkeyCache(): void {
  subkeyCache.clear();
}
