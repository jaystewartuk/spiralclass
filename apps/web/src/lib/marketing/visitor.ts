import { createHmac } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { VISITOR_COOKIE } from "./visitor-cookie";

// Server-side half of the visitor id (see ./visitor-cookie for why it is
// split).
//
// The raw cookie value is a stable handle to one browser. Storing an HMAC of it
// under a server-side secret means the stored value is useless outside this
// application, cannot be looked up from a cookie someone hands us, and is not
// reversible into anything about a person. We never store IP, user agent, or a
// referrer path — only an origin.
//
// Deliberately SEPARATE from PostHog's distinct id (the analytics rail already
// handles that) and from the ap_src attribution cookie (first-touch marketing
// source, absent on a direct visit).

export { VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE_SECONDS, newVisitorId } from "./visitor-cookie";

/** Storage form of a raw visitor id. Never store the raw value. */
export function hashVisitorId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const secret = serverEnv().SESSION_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`ap_vid:${raw}`).digest("hex").slice(0, 32);
}

/**
 * The current request's visitor hash, or null outside a request scope. Reads
 * only — the cookie is minted by the middleware, the one place that can set a
 * cookie on a Server Component render.
 */
export async function currentVisitorHash(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    return hashVisitorId(store.get(VISITOR_COOKIE)?.value);
  } catch {
    return null;
  }
}
