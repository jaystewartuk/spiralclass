// HTML text escaping for the handful of routes that build markup by hand.
//
// Almost nothing in this app does: React escapes interpolated text for you,
// and every page goes through it. The exceptions are the standalone pages
// served by route handlers — the /r/* redirect routers and the unsubscribe
// flow — which render outside the app shell and so assemble their own
// document, interpolating catalog strings into markup themselves.
//
// One copy, because two copies of an escaper is how one of them ends up
// missing a character. (lib/email/html-shell.ts keeps its own, deliberately:
// it sits with escapeAttr and safeHref, which are about email-client quirks
// rather than about this.)

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for interpolation into HTML element content or a quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
