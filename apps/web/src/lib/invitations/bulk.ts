import { INVITATION_BULK_MAX } from "./constants";

// Bulk-invite parsing + validation. Pure (no DB) so it's fully unit-testable;
// the caller passes in the DB-derived email sets. Accepts two input shapes the
// invite UI offers — a pasted list and a CSV import — through one parser, since
// both reduce to "one invitee per line."

export type ParsedInvitee = {
  name: string | null;
  email: string; // normalized: trimmed + lowercased
  rawLine: string;
  lineNumber: number;
};

export type ParseIssue = {
  lineNumber: number;
  rawLine: string;
  reason: "invalid_email" | "missing_email";
};

export type ParseResult = {
  entries: ParsedInvitee[];
  issues: ParseIssue[];
  // True when the input exceeded INVITATION_BULK_MAX and was truncated — the UI
  // surfaces this rather than silently dropping rows.
  truncated: boolean;
};

// Deliberately conservative email shape — same spirit as the zod `.email()`
// used at the write boundary, applied here so the confirmation screen can flag
// bad rows before anything is sent.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// Pull the email + (optional) name out of a single line. Supports:
//   mira@example.com
//   Mira López, mira@example.com
//   mira@example.com, Mira López
//   Mira López <mira@example.com>
//   tab / semicolon / comma separated (CSV or paste)
function parseLine(rawLine: string, lineNumber: number): ParsedInvitee | ParseIssue {
  const line = rawLine.trim();
  // "Name <email>" form first — extract the bracketed address, keep the rest as
  // the name.
  const angle = /^(.*)<([^>]+)>\s*$/.exec(line);
  let name: string | null = null;
  let tokens: string[];
  if (angle) {
    name = angle[1].trim() || null;
    tokens = [angle[2].trim()];
  } else {
    tokens = line
      .split(/[,;\t]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const emailToken = tokens.find((t) => EMAIL_RE.test(normalizeEmail(t)));
  if (!emailToken) {
    // A line with content but no email at all is a distinct issue from a
    // malformed address, so the UI can word it usefully.
    const looksLikeAttemptedEmail = tokens.some((t) => t.includes("@"));
    return {
      lineNumber,
      rawLine,
      reason: looksLikeAttemptedEmail ? "invalid_email" : "missing_email",
    };
  }
  const email = normalizeEmail(emailToken);
  if (name === null) {
    const nameParts = tokens.filter((t) => normalizeEmail(t) !== email);
    name = nameParts.join(" ").trim() || null;
  }
  return { name, email, rawLine, lineNumber };
}

export function parseInviteeList(input: string): ParseResult {
  const entries: ParsedInvitee[] = [];
  const issues: ParseIssue[] = [];
  const lines = input.split(/\r?\n/);
  let truncated = false;
  let lineNumber = 0;
  // Skip a header row like "name,email" / "email,name" that a CSV export adds.
  const looksLikeHeader = (l: string) =>
    /^\s*("?name"?|"?nombre"?|"?email"?|"?correo"?)(\s*[,;\t].*)?$/i.test(l) &&
    !EMAIL_RE.test(normalizeEmail(l));

  for (const raw of lines) {
    lineNumber += 1;
    if (raw.trim() === "") continue;
    if (lineNumber === 1 && looksLikeHeader(raw)) continue;
    if (entries.length >= INVITATION_BULK_MAX) {
      truncated = true;
      break;
    }
    const parsed = parseLine(raw, lineNumber);
    if ("email" in parsed) entries.push(parsed);
    else issues.push(parsed);
  }
  return { entries, issues, truncated };
}

// The per-invitee outcome shown on the confirmation screen. `ok` rows are the
// only ones that get sent.
export type InviteeDisposition =
  | "ok"
  | "duplicate_in_list"
  | "already_connected" // student already has a login on this teacher's roster
  | "already_invited"; // a live (pending) invitation already exists

export type ClassifiedInvitee = ParsedInvitee & { disposition: InviteeDisposition };

export type ClassifyInput = {
  entries: ParsedInvitee[];
  // Emails already connected (a roster Student with an auth login) — inviting
  // them again is a no-op, so they're flagged not sent.
  connectedEmails: ReadonlySet<string>;
  // Emails with a live pending invitation already outstanding.
  pendingEmails: ReadonlySet<string>;
};

export type ClassifyResult = {
  classified: ClassifiedInvitee[];
  sendable: ClassifiedInvitee[];
  counts: Record<InviteeDisposition, number>;
};

// Classify every parsed entry against the DB-derived sets + intra-list dupes.
// The first occurrence of an email wins; later duplicates in the same paste are
// flagged `duplicate_in_list`.
export function classifyInvitees(input: ClassifyInput): ClassifyResult {
  const seen = new Set<string>();
  const classified: ClassifiedInvitee[] = input.entries.map((entry) => {
    let disposition: InviteeDisposition;
    if (seen.has(entry.email)) disposition = "duplicate_in_list";
    else if (input.connectedEmails.has(entry.email)) disposition = "already_connected";
    else if (input.pendingEmails.has(entry.email)) disposition = "already_invited";
    else disposition = "ok";
    seen.add(entry.email);
    return { ...entry, disposition };
  });
  const counts: Record<InviteeDisposition, number> = {
    ok: 0,
    duplicate_in_list: 0,
    already_connected: 0,
    already_invited: 0,
  };
  for (const c of classified) counts[c.disposition] += 1;
  return {
    classified,
    sendable: classified.filter((c) => c.disposition === "ok"),
    counts,
  };
}
