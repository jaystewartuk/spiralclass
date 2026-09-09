import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-signed "notification settings" link tokens. Every notification email
// carries one of these (alongside, and independent from, the student-only
// unsubscribe token in lib/email/opt-out-token.ts) so the recipient — teacher
// or student — can jump straight to their notification preferences.
//
// Format: base64url(payload).base64url(signature)
//   payload = JSON({ r: recipientId, y: recipientType, t: teacherId, k: "notif-settings", e: epochSeconds })
//   signature = HMAC-SHA256(payload, secret)
//
// Re-uses SESSION_SECRET as the signing key. The `k` discriminator prevents a
// token-swap between this route and the unrelated opt-out routes.

const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days — matches the opt-out token TTL
const KIND = "notif-settings";

export type NotificationSettingsLinkPayload = {
  recipientId: string;
  recipientType: "student" | "teacher";
  teacherId: string;
};

export function signNotificationSettingsToken(
  payload: NotificationSettingsLinkPayload,
  secret: string,
  now: Date = new Date(),
): string {
  const body = JSON.stringify({
    r: payload.recipientId,
    y: payload.recipientType,
    t: payload.teacherId,
    k: KIND,
    e: Math.floor(now.getTime() / 1000),
  });
  const encoded = base64url(Buffer.from(body, "utf8"));
  const sig = createHmac("sha256", secret).update(encoded).digest();
  return `${encoded}.${base64url(sig)}`;
}

export type VerifyNotificationSettingsTokenResult =
  | { ok: true; payload: NotificationSettingsLinkPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "bad-payload" | "wrong-kind" };

export function verifyNotificationSettingsToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): VerifyNotificationSettingsTokenResult {
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

  let body: { r?: string; y?: string; t?: string; k?: string; e?: number };
  try {
    body = JSON.parse(base64urlDecode(encoded).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof body.r !== "string" ||
    (body.y !== "student" && body.y !== "teacher") ||
    typeof body.t !== "string" ||
    typeof body.e !== "number"
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  if (body.k !== KIND) {
    return { ok: false, reason: "wrong-kind" };
  }
  const ageSeconds = Math.floor(now.getTime() / 1000) - body.e;
  if (ageSeconds < 0 || ageSeconds > TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: { recipientId: body.r, recipientType: body.y, teacherId: body.t } };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}
