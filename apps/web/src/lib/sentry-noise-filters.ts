// Static (non-`beforeSend`) noise filters for the client Sentry init
// (SPIRALCLASS-2T). Extracted from `instrumentation-client.ts` so the
// patterns are unit-testable — Sentry's own `ignoreErrors`/`denyUrls`
// matching happens inside the SDK, so pinning tests here just guards the
// regexes themselves against a typo silently widening or narrowing what
// gets dropped.
//
// Both target the same source: crypto-wallet browser extensions (and
// wallet in-app browsers) inject an `ethereum` provider into every page
// they open — including booking links — and can throw when that injection
// races the page load. `window.ethereum` appears nowhere in this app, so
// this is pure third-party noise, not a bug of ours.

// Matched against the exception message. Sentry's own message-matching for
// `ignoreErrors` already substring/regex-tests this against
// `event.exception.values[].value` and `event.message`, so a plain regex is
// enough here — no need to duplicate that matching logic.
export const SENTRY_IGNORE_ERRORS: RegExp[] = [/window\.ethereum/];

// Matched against the top (crashing) stack frame's URL. Drops errors whose
// own code lives in a browser extension's scheme rather than this app's
// origin — covers the same wallet-extension family (and future ones) without
// depending on a specific error message string.
export const SENTRY_DENY_URLS: RegExp[] = [
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /^safari-extension:\/\//,
  /^safari-web-extension:\/\//,
];
