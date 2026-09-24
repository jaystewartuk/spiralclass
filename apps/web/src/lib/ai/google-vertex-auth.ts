import "server-only";
import { createSign } from "node:crypto";
import { geminiVertexServiceAccount, runsOnCloudRun } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger({ surface: "ai" });

// Returns a short-lived OAuth2 access token for Vertex AI, without the
// `google-auth-library` dependency — same posture as wise/api.ts's own RSA
// signing via node:crypto rather than a vendor SDK.
//
// Why OAuth2 at all, when gemini-image.ts used to be a bare API key: Vertex AI
// (unlike the public Generative Language API / AI Studio) has no separate
// "Prepay" product — it bills through the SAME Cloud Billing account as every
// other GCP service, postpaid. The API-key surface doesn't exist on Vertex;
// every call is OAuth2 (D-127).
//
// Two sources, tried in this order:
//
//   1. A service account KEY, when GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64 is
//      set. Self-signed JWT → token exchange (RFC 7523), the same flow
//      `google-auth-library`'s `JWT` client performs internally: sign a JWT
//      claiming the cloud-platform scope, `aud` the token endpoint, issued by
//      the service account's own email; exchange it at
//      https://oauth2.googleapis.com/token for a bearer token good for ~1h.
//      This is the off-GCP path — a laptop has no ambient Google credential.
//      It wins when present so that production keeps working on the key until
//      the operator removes it, rather than depending on the order of a deploy
//      and an IAM grant.
//
//   2. The Cloud Run runtime identity, when there is no key and the process
//      runs on Cloud Run (runsOnCloudRun()). The metadata server hands out a
//      token for the service's own service account (`web-runtime`) on request —
//      no stored credential, nothing to rotate, nothing to leak. D-127 chose a
//      key only because production then ran on Fly, which has no metadata
//      server; since D-184 it does not.
//
// Either way the token is cached in module scope (this process's lifetime) and
// refreshed a minute before expiry — same shape as prisma.ts's globalThis
// singleton, just for a token instead of a connection.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Plain HTTP by design: the metadata server is link-local to the instance and
// Google documents only this form. The `Metadata-Flavor` header is what it
// checks, to refuse requests a proxy or an SSRF-able fetch could forge without it.
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Refresh this many seconds before the token's own expiry, so a request that
// starts just under the wire doesn't get a token that dies mid-flight.
const REFRESH_SKEW_SECONDS = 60;
// This fetch had no deadline at all until 2026-08-26: a slow/unresponsive
// oauth2.googleapis.com held the request open indefinitely, and — with no
// request coalescing here, so a burst of concurrent generate calls each mint
// their own token exchange — a handful of teachers retrying a stuck
// "Generate" button was enough to pin every concurrency slot the Fly proxy
// production then ran behind allowed the machine, which read as "the whole
// site is down" (health checks included) rather than "image generation is
// slow." Token exchange is a same-datacenter-class round trip; it either
// answers in a couple seconds or something is actually wrong, so this stays
// well under IMAGE_GENERATION_TIMEOUT_MS rather than sharing it. The metadata
// server is closer still, and gets the same bound for the same reason.
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

type TokenSource = "service-account-key" | "cloud-run-identity";

// `source` is part of the cache so a token minted for one identity is never
// served for the other — the configuration does not change within a process
// in production, but nothing here needs to assume it.
let cached: { accessToken: string; expiresAtMs: number; source: TokenSource } | null = null;

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

/** One token request, bounded and never throwing. Both sources answer with the
 * same `{access_token, expires_in}` body, so they share every failure branch. */
async function requestToken(
  source: TokenSource,
  url: string,
  init: RequestInit,
): Promise<{ accessToken: string; expiresInSeconds: number } | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log.warn("vertex token exchange transport failure", { source, timedOut });
    return undefined;
  }

  if (!res.ok) {
    log.warn("vertex token exchange failed", { source, status: res.status });
    return undefined;
  }

  const payload = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!payload?.access_token) {
    log.warn("vertex token exchange: unparseable response", { source });
    return undefined;
  }
  return { accessToken: payload.access_token, expiresInSeconds: payload.expires_in ?? 3600 };
}

/** Returns a valid Vertex AI bearer token, minting/refreshing as needed.
 * `undefined` when there is no credential — no key configured and not on
 * Cloud Run — or when minting one failed. */
export async function getVertexAccessToken(): Promise<string | undefined> {
  const account = geminiVertexServiceAccount();
  const source: TokenSource | undefined = account
    ? "service-account-key"
    : runsOnCloudRun()
      ? "cloud-run-identity"
      : undefined;
  if (!source) return undefined;

  const nowMs = Date.now();
  if (
    cached &&
    cached.source === source &&
    cached.expiresAtMs - REFRESH_SKEW_SECONDS * 1000 > nowMs
  ) {
    return cached.accessToken;
  }

  const minted = account
    ? await requestToken(source, TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signJwt(account.clientEmail, account.privateKey),
        }),
      })
    : await requestToken(source, METADATA_TOKEN_URL, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
      });
  if (!minted) return undefined;

  cached = {
    accessToken: minted.accessToken,
    expiresAtMs: nowMs + minted.expiresInSeconds * 1000,
    source,
  };
  return cached.accessToken;
}

// Test-only: the module-scope cache would otherwise leak a token minted in
// one test into the next.
export function __resetVertexAccessTokenCacheForTests(): void {
  cached = null;
}
