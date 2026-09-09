// Guard for post-auth redirect targets (`?next=`). Returns `next` only when it
// is a safe INTERNAL path: it starts with a single "/" and is NOT a
// protocol-relative ("//host") or backslash-tricked ("/\\host") URL — both of
// which a browser resolves OFF-SITE, so a bare `startsWith("/")` check is an
// open redirect (`new URL("//evil.com", origin)` → `https://evil.com/`).
// Anything else returns null so the caller falls back to a safe default.
//
// Centralizes what used to be scattered `next.startsWith("/")` checks across the
// auth actions, the OAuth completion route, and the social sign-in button.
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string") return null;
  if (!next.startsWith("/")) return null;
  // The WHATWG URL parser (and every browser) STRIPS ASCII tab (\t), newline
  // (\n) and carriage-return (\r) out of a URL before resolving it, so
  // `new URL("/\t//evil.com", origin)` → `https://evil.com/`. A crafted
  // `?next=/%09//evil.com` therefore slips past the prefix checks below (it
  // starts with "/", not "//" or "/\\") yet becomes an OPEN REDIRECT the moment
  // it's handed to `new URL(next, APP_URL)` in publicUrl()/toPublicOrigin() and
  // returned in a `Location:` header after a real sign-in. A genuine internal
  // path never carries a control character — reject any so a browser-stripped
  // form can't smuggle a host past this guard.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(next)) return null;
  // Reject protocol-relative and backslash-normalized-to-slash forms.
  if (next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}
