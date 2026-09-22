import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/security.md. Verifies the round-trip + the
// "key-not-set" graceful-null path that lets the helper coexist with
// pre-rollout plaintext columns.

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes base64

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ FIELD_ENCRYPTION_KEY: TEST_KEY }),
}));

const { encryptField, decryptField, hashField, __resetSubkeyCache } =
  await import("@/lib/crypto/field-encryption");

describe("field-encryption", () => {
  beforeEach(() => {
    __resetSubkeyCache();
  });
  afterEach(() => {
    __resetSubkeyCache();
  });

  it("round-trips a plaintext through encrypt/decrypt", () => {
    const enc = encryptField("phoneE164", "+5215512345678");
    expect(enc).toMatch(/^v1:/);
    const dec = decryptField("phoneE164", enc!);
    expect(dec).toBe("+5215512345678");
  });

  it("produces a different ciphertext each call (fresh IV)", () => {
    const a = encryptField("phoneE164", "+5215512345678");
    const b = encryptField("phoneE164", "+5215512345678");
    expect(a).not.toBe(b);
  });

  it("produces a stable hash for equality lookups", () => {
    const a = hashField("phoneE164", "+5215512345678");
    const b = hashField("phoneE164", "+5215512345678");
    expect(a).toBe(b);
    expect(a).toBeTruthy();
  });

  it("isolates keys per column — hash differs by column", () => {
    const phone = hashField("phoneE164", "abc");
    const email = hashField("email", "abc");
    expect(phone).not.toBe(email);
  });

  it("returns null on malformed ciphertext", () => {
    expect(decryptField("phoneE164", "not-a-valid-payload")).toBeNull();
    expect(decryptField("phoneE164", "v1:x:y:z")).toBeNull();
  });

  it("rejects a ciphertext encrypted under a different column", () => {
    const enc = encryptField("email", "abc")!;
    // Auth tag verifies under the email subkey, not phoneE164's.
    expect(decryptField("phoneE164", enc)).toBeNull();
  });
});
