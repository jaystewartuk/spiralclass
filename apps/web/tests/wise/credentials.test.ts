import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-teacher Wise credential write path. Mocks the env so field-encryption
// is active (mirrors tests/crypto/field-encryption.test.ts), then checks the
// connect flow seals the secrets and wiseClientForTeacher gates correctly.

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes base64

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ FIELD_ENCRYPTION_KEY: TEST_KEY }),
}));

const { decryptField, __resetSubkeyCache } = await import("@/lib/crypto/field-encryption");
const { connectTeacherWise, disconnectTeacherWise } = await import("@/lib/wise/credentials");
const { wiseClientForTeacher, WISE_TOKEN_COLUMN, WISE_KEY_COLUMN } = await import("@/lib/wise/api");

function fakePrisma() {
  const store: Record<string, any> = {};
  return {
    store,
    prisma: {
      // D-113: credentials live on the Wise instrument, and the write is an
      // upsert (an operator can connect the API before the teacher has filled
      // in a Wisetag, so the row may not exist yet).
      teacherPayoutInstrument: {
        upsert: async ({ create, update }: any) => {
          Object.assign(store, create ?? {}, update ?? {});
          return store;
        },
        updateMany: async ({ data }: any) => {
          Object.assign(store, data);
          return { count: 1 };
        },
      },
    } as any,
  };
}

describe("connectTeacherWise", () => {
  beforeEach(() => __resetSubkeyCache());
  afterEach(() => __resetSubkeyCache());

  it("generates a keypair, seals the secrets, returns the public key", async () => {
    const { store, prisma } = fakePrisma();
    const { publicKeyPem } = await connectTeacherWise(prisma, {
      teacherId: "t1",
      profileId: "98765",
      token: "live-token-xyz",
    });

    expect(publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(store.wiseApiProfileId).toBe("98765");

    // Token is stored encrypted and decrypts back to the original.
    expect(store.wiseApiTokenEnc).toMatch(/^v1:/);
    expect(decryptField(WISE_TOKEN_COLUMN, store.wiseApiTokenEnc)).toBe("live-token-xyz");

    // Private key is stored encrypted and decrypts to a PEM private key.
    expect(store.wiseApiKeyEnc).toMatch(/^v1:/);
    expect(decryptField(WISE_KEY_COLUMN, store.wiseApiKeyEnc)).toMatch(/BEGIN PRIVATE KEY/);
  });

  it("disconnect clears the three credential columns", async () => {
    const { store, prisma } = fakePrisma();
    await disconnectTeacherWise(prisma, "t1");
    expect(store.wiseApiProfileId).toBeNull();
    expect(store.wiseApiTokenEnc).toBeNull();
    expect(store.wiseApiKeyEnc).toBeNull();
  });
});

describe("wiseClientForTeacher gating", () => {
  beforeEach(() => __resetSubkeyCache());
  afterEach(() => __resetSubkeyCache());

  const complete = {
    wiseApiProfileId: "1",
    wiseApiTokenEnc: "tok",
    wiseApiKeyEnc: "key",
    pricingCurrency: "MXN",
  };

  it("builds a client when fully connected", () => {
    expect(wiseClientForTeacher(complete)).not.toBeNull();
  });

  // "Wise is paused" is no longer a property of these creds: since D-113 the
  // instrument's own `enabled` flag is the gate, and the reconciler's query
  // filters on it before ever building a client (see lib/payments/
  // wise-reconcile.ts). Asserting it here would test the fixture, not the
  // code — tests/wise/reconcile.test.ts covers the real gate.

  it("returns null when any credential column is missing", () => {
    expect(wiseClientForTeacher({ ...complete, wiseApiProfileId: null })).toBeNull();
    expect(wiseClientForTeacher({ ...complete, wiseApiTokenEnc: null })).toBeNull();
    expect(wiseClientForTeacher({ ...complete, wiseApiKeyEnc: null })).toBeNull();
  });
});
