/**
 * Load `url` as a new document, not a client-side navigation. For a change of
 * language on a public page (D-193): the root layout carries the language as
 * well as the page, and a client-side navigation keeps the layout it already
 * has. A module of its own so a test can see where it was sent.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
