import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";
import {
  GOOGLE_OAUTH_AUTH_ENDPOINT,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  googleRedirectUri,
} from "./config";

// Google OAuth 2.0 (authorization-code) helpers built on plain fetch — no SDK,
// matching the codebase's lightweight Wise/Meta integrations. Read-only.

const STATE_TTL_SECONDS = 60 * 15; // the consent round-trip is short-lived

export type GoogleTokens = {
  accessToken: string;
  // Present only on the first consent (access_type=offline & prompt=consent).
  refreshToken: string | null;
  expiresInSeconds: number;
  idToken: string | null;
};

/** Build the consent-screen URL. `state` is our signed CSRF/teacher token. */
export function buildGoogleAuthUrl(state: string): string {
  const env = serverEnv();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    // offline + consent → we receive a refresh token we can poll with later.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  const env = serverEnv();
  const res = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`google token exchange failed: ${res.status} ${await safeBody(res)}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresInSeconds: json.expires_in,
    idToken: json.id_token ?? null,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const env = serverEnv();
  const res = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed: ${res.status} ${await safeBody(res)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

/** Best-effort revoke of a refresh token on disconnect. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Revocation is courtesy cleanup; the row is deleted regardless.
  }
}

/** Pull the `email` claim out of an OIDC id_token (already TLS-trusted from Google). */
export function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

// ---- Signed OAuth state (CSRF + teacher binding) -------------------------
// Mirrors the HMAC opt-out token: base64url(payload).base64url(sig), where
// payload = { t: teacherId, e: epochSeconds }, signed with SESSION_SECRET.

export function signOAuthState(teacherId: string, secret: string, now: Date = new Date()): string {
  const body = JSON.stringify({ t: teacherId, e: Math.floor(now.getTime() / 1000) });
  const encoded = base64url(Buffer.from(body, "utf8"));
  const sig = createHmac("sha256", secret).update(encoded).digest();
  return `${encoded}.${base64url(sig)}`;
}

export type VerifyStateResult =
  | { ok: true; teacherId: string }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyOAuthState(
  state: string,
  secret: string,
  now: Date = new Date(),
): VerifyStateResult {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, sigEncoded] = parts;

  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sigEncoded);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expectedSig = createHmac("sha256", secret).update(encoded).digest();
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "bad-signature" };
  }

  let body: { t?: string; e?: number };
  try {
    body = JSON.parse(base64urlDecode(encoded).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof body.t !== "string" || typeof body.e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  const age = Math.floor(now.getTime() / 1000) - body.e;
  if (age < 0 || age > STATE_TTL_SECONDS) return { ok: false, reason: "expired" };
  return { ok: true, teacherId: body.t };
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}
