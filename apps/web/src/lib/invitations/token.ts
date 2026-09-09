import { createHash, randomBytes } from "node:crypto";

// Invitation link tokens.
//
// Unlike the HMAC-signed opt-out / notification-settings tokens (which are
// self-describing and stateless), an invitation link must be REVOCABLE and
// single-active-per-inbox, so it's a DB-backed opaque secret instead:
//
//   * generateInvitationToken() mints 32 bytes of CSPRNG entropy, base64url —
//     256 bits, unguessable, so there's no need to also rate-limit lookups.
//   * hashInvitationToken() is a plain SHA-256 (hex). The token is
//     high-entropy, so a fast hash is safe here (no offline-guessing surface
//     the way a password would have); the point is that the DB stores only the
//     hash, so a table read can't reconstruct a live link.
//
// The raw token travels only in the email link and the URL the student opens;
// the server hashes the inbound token and looks the row up by `token_hash`.

export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

// The token as it appears in a URL is base64url: [A-Za-z0-9_-]. Reject obvious
// junk before a DB round-trip (defense-in-depth; a bad token just misses).
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,512}$/;

export function isWellFormedInvitationToken(raw: string): boolean {
  return TOKEN_SHAPE.test(raw);
}
