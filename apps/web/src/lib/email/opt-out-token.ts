import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-signed email opt-out tokens — scoped to the email channel.
//
// Format: base64url(payload).base64url(signature)
//   payload = JSON({ s: studentId, t: teacherId, k: "email", e: epochSeconds })
//   signature = HMAC-SHA256(payload, secret)
//
// Re-uses SESSION_SECRET as the signing key. The `k` discriminator
// prevents a token-swap if both routes share the same secret namespace.

const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const KIND = "email";

export type EmailOptOutPayload = {
  studentId: string;
  teacherId: string;
};

export function signEmailOptOutToken(
  payload: EmailOptOutPayload,
  secret: string,
  now: Date = new Date(),
): string {
  const body = JSON.stringify({
    s: payload.studentId,
    t: payload.teacherId,
    k: KIND,
    e: Math.floor(now.getTime() / 1000),
  });
  const encoded = base64url(Buffer.from(body, "utf8"));
  const sig = createHmac("sha256", secret).update(encoded).digest();
  return `${encoded}.${base64url(sig)}`;
}

export type VerifyEmailOptOutResult =
  | { ok: true; payload: EmailOptOutPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "bad-payload" | "wrong-kind" };

export function verifyEmailOptOutToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): VerifyEmailOptOutResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, sigEncoded] = parts;

  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sigEncoded);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expectedSig = createHmac("sha256", secret).update(encoded).digest();
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "bad-signature" };
  }

  let body: { s?: string; t?: string; k?: string; e?: number };
  try {
    body = JSON.parse(base64urlDecode(encoded).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof body.s !== "string" || typeof body.t !== "string" || typeof body.e !== "number") {
    return { ok: false, reason: "bad-payload" };
  }
  if (body.k !== KIND) {
    return { ok: false, reason: "wrong-kind" };
  }
  const ageSeconds = Math.floor(now.getTime() / 1000) - body.e;
  if (ageSeconds < 0 || ageSeconds > TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: { studentId: body.s, teacherId: body.t } };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}
