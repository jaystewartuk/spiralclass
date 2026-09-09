import "server-only";
import { createSign } from "node:crypto";
import { geminiVertexServiceAccount } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger({ surface: "ai" });

// Mints a short-lived OAuth2 access token for Vertex AI from a service
// account key, without the `google-auth-library` dependency — same posture
// as wise/api.ts's own RSA signing via node:crypto rather than a vendor SDK.
//
// Why a service account at all, when gemini-image.ts used to be a bare API
// key: Vertex AI (unlike the public Generative Language API / AI Studio) has
// no separate "Prepay" product — it bills through the SAME Cloud Billing
// account as every other GCP service, postpaid. The API-key surface doesn't
// exist on Vertex; every call is OAuth2, which off-GCP (this app runs on
// Fly, not GCP, so there's no ambient metadata-server credential) means a
// service account key is the only option.
//
// Self-signed JWT → token exchange (RFC 7523), the same flow
// `google-auth-library`'s `JWT` client performs internally:
//   1. Sign a JWT claiming the cloud-platform scope, `aud` the token
//      endpoint, issued by the service account's own email.
//   2. Exchange it at https://oauth2.googleapis.com/token for a bearer
//      token good for ~1h.
// Cached in module scope (this process's lifetime) and refreshed a minute
// before expiry — same shape as prisma.ts's globalThis singleton, just for a
// token instead of a connection.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Refresh this many seconds before the token's own expiry, so a request that
// starts just under the wire doesn't get a token that dies mid-flight.
const REFRESH_SKEW_SECONDS = 60;
// This fetch had no deadline at all until 2026-08-26: a slow/unresponsive
// oauth2.googleapis.com held the request open indefinitely, and — with no
// request coalescing here, so a burst of concurrent generate calls each mint
// their own token exchange — a handful of teachers retrying a stuck
// "Generate" button was enough to pin every concurrency slot Fly's proxy
// allows the machine, which reads as "the whole site is down" (health checks
// included) rather than "image generation is slow." Token exchange is a
// same-datacenter-class round trip; it either answers in a couple seconds or
// something is actually wrong, so this stays well under
// IMAGE_GENERATION_TIMEOUT_MS rather than sharing it.
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

let cached: { accessToken: string; expiresAtMs: number } | null = null;

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString("base64url");
}

function signJwt(clientEmail: string, privateKey: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** Returns a valid Vertex AI bearer token, minting/refreshing as needed.
 * `undefined` when the service account credential isn't configured. */
export async function getVertexAccessToken(): Promise<string | undefined> {
  const account = geminiVertexServiceAccount();
  if (!account) return undefined;

  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - REFRESH_SKEW_SECONDS * 1000 > nowMs) {
    return cached.accessToken;
  }

  const assertion = signJwt(account.clientEmail, account.privateKey);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log.warn("vertex token exchange transport failure", { timedOut });
    return undefined;
  }

  if (!res.ok) {
    log.warn("vertex token exchange failed", { status: res.status });
    return undefined;
  }

  const payload = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!payload?.access_token) {
    log.warn("vertex token exchange: unparseable response");
    return undefined;
  }

  cached = {
    accessToken: payload.access_token,
    expiresAtMs: nowMs + (payload.expires_in ?? 3600) * 1000,
  };
  return cached.accessToken;
}

// Test-only: the module-scope cache would otherwise leak a token minted in
// one test into the next.
export function __resetVertexAccessTokenCacheForTests(): void {
  cached = null;
}
