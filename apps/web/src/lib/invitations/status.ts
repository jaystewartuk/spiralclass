import type { InvitationStatus, StudentInvitation } from "@prisma/client";

// The five states a teacher sees per student, as required by the invitation
// dashboard. `not_invited` is a roster-level state (a student with no live
// invitation) computed by the dashboard aggregator, not stored on a row.
export type EffectiveInvitationStatus = "pending" | "accepted" | "expired" | "cancelled";

// Derive the DISPLAY status of an invitation row. Expiry is computed, never
// written: a row stays `pending` in the DB past its expiresAt, and this turns
// it into `expired` at read time (so no sweep has to flip every lapsed row, and
// a resend can revive it by pushing expiresAt out again). Terminal DB states
// (accepted / cancelled) pass through unchanged.
export function effectiveInvitationStatus(
  invitation: Pick<StudentInvitation, "status" | "expiresAt">,
  now: Date = new Date(),
): EffectiveInvitationStatus {
  if (invitation.status === "accepted") return "accepted";
  if (invitation.status === "cancelled") return "cancelled";
  // `expired` is only ever materialized by a hypothetical future sweep; today
  // it's derived from a still-`pending` row whose window has closed.
  if (invitation.status === "expired") return "expired";
  return invitation.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

// A pending invitation whose window has NOT closed — the only state that a
// token can still be accepted from (see lib/invitations/accept.ts).
export function isAcceptable(
  invitation: Pick<StudentInvitation, "status" | "expiresAt">,
  now: Date = new Date(),
): boolean {
  return effectiveInvitationStatus(invitation, now) === "pending";
}

// The DB `status` column values that are terminal (never revived). Used by the
// unique-active-invitation logic and resend guard.
export function isTerminalStatus(status: InvitationStatus): boolean {
  return status === "accepted" || status === "cancelled";
}
