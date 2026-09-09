// Static, per-response security headers applied to every route. Split out of
// next.config.ts so the header set is unit-testable without pulling in
// Next's config loader / the Sentry build-time wrapper.
//
// The Content-Security-Policy is NOT here — it's nonce-based and therefore
// per-request, emitted from middleware instead (see lib/csp.ts).
//
// HSTS: Vercel applied this automatically on the apex + www hosts. Production
// and preview both moved off Vercel onto Fly (D-89), which does not set HSTS
// for you — so without an explicit header here, HTTPS-downgrade protection
// silently went dark on both environments during that cutover. No `preload`
// directive: submitting to browsers' built-in HSTS preload list is a
// separate, effectively irreversible step this repo hasn't taken. Gated on
// `deployEnv` (unset for local/CI builds) so `pnpm dev` over plain HTTP never
// gets a header that could make a browser force HTTPS for a dev host.
export type SecurityHeader = { key: string; value: string };

export function buildSecurityHeaders(deployEnv: string | undefined): SecurityHeader[] {
  const headers = [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // camera/microphone are `self`, not `()`: the in-class video call (D-16)
    // runs getUserMedia in our own top-level document, and an empty
    // allowlist would block it outright. geolocation stays fully off.
    {
      key: "Permissions-Policy",
      value: "geolocation=(), microphone=(self), camera=(self)",
    },
  ];

  if (deployEnv) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  }

  // The preview deployment must never be indexed as a duplicate of
  // production. robots.ts additionally serves a disallow-all on non-prod at
  // runtime; this header covers responses robots.ts's route doesn't.
  if (deployEnv && deployEnv !== "production") {
    headers.push({ key: "X-Robots-Tag", value: "noindex, nofollow" });
  }

  return headers;
}
