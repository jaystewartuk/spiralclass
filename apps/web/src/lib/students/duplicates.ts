import { levenshtein } from "@spiralclass/shared";

// Conservative duplicate detection over a single teacher's roster, powering
// the "possible duplicate" hint on /dashboard/students. A duplicate pair is
// almost always a checkout typo: the funnel keys identity on the typed
// email, so "mira@gmial.com" mints a second Student row whose magic links go
// nowhere while the real row holds the history. Detection is pure +
// in-memory (rosters are tens of rows, O(n²) is nothing).
//
// Signals, strongest first:
//   * same_email    — identical normalized email (legacy rows that predate
//                     the write-boundary normalization);
//   * same_phone    — identical E.164 number on both rows;
//   * similar_email — same local part and a domain within edit distance 2
//                     (the observed "spiralclass.com" vs "agengaprofe.com"
//                     case).
//
// Names are deliberately NOT a signal — two real Marías are common; two
// rows sharing a phone number are not.

export type DuplicateReason = "same_email" | "same_phone" | "similar_email";

export interface RosterDuplicateCandidate {
  studentId: string;
  email: string | null;
  phoneE164: string | null;
}

export interface DuplicatePair {
  aId: string;
  bId: string;
  reason: DuplicateReason;
}

const MAX_PAIRS = 5;

function matchReason(
  a: RosterDuplicateCandidate,
  b: RosterDuplicateCandidate,
): DuplicateReason | null {
  const emailA = a.email?.trim().toLowerCase() ?? null;
  const emailB = b.email?.trim().toLowerCase() ?? null;

  if (emailA && emailB && emailA === emailB) return "same_email";
  if (a.phoneE164 && b.phoneE164 && a.phoneE164 === b.phoneE164) {
    return "same_phone";
  }
  if (emailA && emailB) {
    const [localA, domainA] = splitEmail(emailA);
    const [localB, domainB] = splitEmail(emailB);
    if (
      localA !== null &&
      localB !== null &&
      localA === localB &&
      domainA !== domainB &&
      levenshtein(domainA!, domainB!) <= 2
    ) {
      return "similar_email";
    }
  }
  return null;
}

function splitEmail(email: string): [string | null, string | null] {
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    return [null, null];
  }
  return [email.slice(0, at), email.slice(at + 1)];
}

// Greedy pairing: each student appears in at most one pair so the UI never
// proposes overlapping merges; capped so a pathological roster can't flood
// the page. Pair order follows the input order (callers pass newest-first).
export function findRosterDuplicates(candidates: RosterDuplicateCandidate[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const used = new Set<string>();

  for (let i = 0; i < candidates.length && pairs.length < MAX_PAIRS; i++) {
    const a = candidates[i];
    if (used.has(a.studentId)) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (used.has(b.studentId)) continue;
      const reason = matchReason(a, b);
      if (!reason) continue;
      pairs.push({ aId: a.studentId, bId: b.studentId, reason });
      used.add(a.studentId);
      used.add(b.studentId);
      break;
    }
  }
  return pairs;
}
