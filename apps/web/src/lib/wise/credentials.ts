import type { PrismaClient } from "@prisma/client";
import { encryptField } from "@/lib/crypto/field-encryption";
import { WISE_TOKEN_COLUMN, WISE_KEY_COLUMN, generateWiseSigningKeypair } from "./api";

// Write path for per-teacher Wise API credentials. The token and the RSA
// signing private key are field-encrypted at rest (AES-256-GCM via
// FIELD_ENCRYPTION_KEY); when no master key is configured `encryptField`
// returns null and we store plaintext — the additive-migration contract the
// crypto module documents. The reader (wiseClientForTeacher) mirrors this
// exactly.
//
// Intended caller: an operator/admin connect flow (script or action), not
// the teacher directly — connecting requires generating an SCA keypair and
// the teacher uploading the public half to Wise.
//
// These live on the teacher's WISE INSTRUMENT rather than on the teacher
// (D-113): auto-reconciliation is a capability of the instrument, not of the
// person. That is what makes it structural rather than surprising that the
// SPEI instrument has no equivalent — Mexican retail banks expose no
// per-teacher statement API, so a SPEI payment is teacher-confirmed forever.

function sealToken(token: string): string {
  return encryptField(WISE_TOKEN_COLUMN, token) ?? token;
}

function sealKey(privateKeyPem: string): string {
  return encryptField(WISE_KEY_COLUMN, privateKeyPem) ?? privateKeyPem;
}

export type SetWiseCredsInput = {
  teacherId: string;
  profileId: string;
  token: string;
  privateKeyPem: string;
};

// Stores a complete, already-generated credential set. Use when you already
// hold the teacher's signing private key (e.g. re-running setup).
export async function setWiseApiCredentials(
  prisma: Pick<PrismaClient, "teacherPayoutInstrument">,
  input: SetWiseCredsInput,
): Promise<void> {
  // Upsert: a teacher can be connected to the Wise API before she has filled
  // in a Wisetag (the operator flow runs independently of her settings page),
  // so the instrument row may not exist yet. It stays `enabled: false` until
  // she supplies the handle the student actually pays to — the CHECK
  // constraint would reject an enabled row without one anyway.
  await prisma.teacherPayoutInstrument.upsert({
    where: { teacherId_kind: { teacherId: input.teacherId, kind: "wise" } },
    create: {
      teacherId: input.teacherId,
      kind: "wise",
      enabled: false,
      wiseApiProfileId: input.profileId,
      wiseApiTokenEnc: sealToken(input.token),
      wiseApiKeyEnc: sealKey(input.privateKeyPem),
    },
    update: {
      wiseApiProfileId: input.profileId,
      wiseApiTokenEnc: sealToken(input.token),
      wiseApiKeyEnc: sealKey(input.privateKeyPem),
    },
  });
}

export type ConnectWiseInput = {
  teacherId: string;
  profileId: string;
  token: string;
};

// One-shot connect: generates a fresh SCA keypair, stores the private half
// (encrypted) alongside the token + profile id, and returns the PUBLIC key
// PEM for the teacher to upload under Wise → Settings → API tokens. Auto-
// reconciliation goes live for this teacher on the next cron tick once the
// public key is uploaded.
export async function connectTeacherWise(
  prisma: Pick<PrismaClient, "teacherPayoutInstrument">,
  input: ConnectWiseInput,
): Promise<{ publicKeyPem: string }> {
  const { publicKeyPem, privateKeyPem } = generateWiseSigningKeypair();
  await setWiseApiCredentials(prisma, {
    teacherId: input.teacherId,
    profileId: input.profileId,
    token: input.token,
    privateKeyPem,
  });
  return { publicKeyPem };
}

// Removes a teacher's Wise API connection (drops them back to teacher-
// confirmed mode). Leaves the instrument enabled and the Wisetag untouched —
// she keeps taking Wise payments, she just confirms each one by hand.
// `updateMany` rather than `update` so disconnecting a teacher who never had
// an instrument row is a no-op instead of a throw.
export async function disconnectTeacherWise(
  prisma: Pick<PrismaClient, "teacherPayoutInstrument">,
  teacherId: string,
): Promise<void> {
  await prisma.teacherPayoutInstrument.updateMany({
    where: { teacherId, kind: "wise" },
    data: {
      wiseApiProfileId: null,
      wiseApiTokenEnc: null,
      wiseApiKeyEnc: null,
    },
  });
}
