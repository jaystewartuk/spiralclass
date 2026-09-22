// Same-origin assertion for cookie-authenticated mutating routes (audit
// finding: no CSRF protection on cookie-authed POSTs). Browsers attach the
// session cookie automatically on cross-site form posts, so a state-changing
// route that trusts only the cookie is forgeable from another origin. We
// reject when the request demonstrably comes from a different site.
//
// Two independent signals, both fail-open only when *absent* (an attacker
// can't strip a header the browser controls):
//   * Sec-Fetch-Site — set by all modern browsers on every request. Allowed
//     values are "same-origin" and "none" (a user-initiated navigation, e.g.
//     typing the URL). "same-site" and "cross-site" are rejected.
//   * Origin — when present, its host must equal the request host.
//
// Do NOT apply to webhook routes (signature-verified) or GET handlers (which
// must not mutate state).

export class CrossOriginError extends Error {
  constructor(public reason: string) {
    super(`cross-origin request rejected: ${reason}`);
    this.name = "CrossOriginError";
  }
}

// Returns true when the request is same-origin (or carries no cross-origin
// signal at all). Returns false when a present signal proves it crossed sites.
export function isSameOrigin(req: Request): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      // A malformed Origin header is not something a same-origin browser
      // request produces — treat it as hostile.
      return false;
    }
    const requestHost = req.headers.get("host") ?? new URL(req.url).host;
    if (originHost !== requestHost) return false;
  }

  return true;
}

// Throwing variant for use at the top of a mutating handler. Throws
// CrossOriginError (caught by the route's error wrapper) when cross-origin.
export function assertSameOrigin(req: Request): void {
  if (!isSameOrigin(req)) {
    throw new CrossOriginError("origin mismatch");
  }
}
