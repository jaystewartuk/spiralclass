// Domain-typo detection for the public checkout funnel.
//
// Student identity is keyed on the email typed into the checkout form: an
// unrecognized address becomes a brand-new Student row, so a one-keystroke
// domain typo ("gmial.com") silently mints a second roster identity whose
// magic links go to an address that doesn't exist. This module powers the
// non-blocking "Did you mean …?" hint that catches the common case before
// it becomes a support ticket.
//
// Suggestions only ever derive from the visitor's own input matched against
// the static provider list below — never from roster data, which would leak
// other students' addresses on a public page.

// Ordered by rough global popularity, with the regional providers that a
// misspelling most often lands near kept in the list; ties in edit distance
// resolve to the earlier entry. Students are anywhere in the world, so this is
// a typo-correction shortlist rather than a claim about where they are.
const COMMON_DOMAINS = [
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "live.com.mx",
  "live.com",
  "yahoo.com.mx",
  "hotmail.es",
  "outlook.es",
  "proton.me",
  "protonmail.com",
  "msn.com",
  "aol.com",
  // Real providers that sit within edit distance 1-2 of the majors; listing
  // them keeps the exact-match guard from "correcting" a legitimate address
  // (mail.com is one insertion from gmail.com, ymail.com one substitution).
  "mail.com",
  "ymail.com",
];

// Classic dynamic-programming edit distance. Inputs are short (email
// domains), so the O(len_a * len_b) cost is irrelevant.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, substitution);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Returns the corrected full address when the domain looks like a typo of a
// common provider, or null when the input is empty, malformed, already a
// known provider, or simply not close to one (custom domains pass through
// untouched — we can't tell a typo'd custom domain from a real one).
export function suggestEmailCorrection(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf("@");
  // Require a non-empty local part and a single "@" with something after it.
  if (at <= 0 || at !== normalized.lastIndexOf("@")) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (domain.length === 0) return null;
  if (COMMON_DOMAINS.includes(domain)) return null;

  let best: { domain: string; distance: number } | null = null;
  for (const candidate of COMMON_DOMAINS) {
    const distance = levenshtein(domain, candidate);
    // Short domains (msn.com, aol.com) tolerate only one slip — two edits
    // on seven characters is more likely a different domain than a typo.
    const threshold = candidate.length <= 7 ? 1 : 2;
    if (distance > threshold) continue;
    if (!best || distance < best.distance) {
      best = { domain: candidate, distance };
    }
  }
  return best ? `${local}@${best.domain}` : null;
}
