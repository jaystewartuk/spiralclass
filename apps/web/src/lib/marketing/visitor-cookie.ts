// The first-party visitor cookie — the EDGE-SAFE half.
//
// Split from ./visitor deliberately: the cookie is minted in the middleware,
// which runs on the Edge runtime where `node:crypto` and `server-only` are both
// unavailable. This file therefore imports nothing and uses only Web Crypto;
// the HMAC that turns a raw id into its stored form lives in ./visitor, which
// only ever runs on the Node server.
//
// Why a visitor id exists at all: without one, "43 visits" and "43 people
// visited" are indistinguishable, and a visit can never be tied to the enquiry
// it produced. Both are the whole point of the acquisition results screen.

export const VISITOR_COOKIE = "ap_vid";

/** 90 days: long enough to connect a slow decision, short enough to expire. */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export function newVisitorId(): string {
  return crypto.randomUUID();
}
