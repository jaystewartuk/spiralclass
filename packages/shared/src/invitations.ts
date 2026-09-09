// Invitation constants kept in one place so the "why join" benefit list and its
// i18n keys can't drift between the accept email and the web accept page.
// Server-only invitation logic (tokens, DB) stays in apps/web/src/lib/invitations.

export type InvitationBenefitKey =
  "scheduling" | "homework" | "aiMaterials" | "notifications" | "messaging";

// The core benefits every invited student sees. `messaging` is appended by the
// email builder only when the teacher has messaging enabled ("if enabled").
export const CORE_BENEFIT_KEYS: readonly InvitationBenefitKey[] = [
  "scheduling",
  "homework",
  "aiMaterials",
  "notifications",
] as const;

// The i18n catalog key for a benefit line — typed as the exact literal so it
// feeds straight into `t()` on both platforms.
export function benefitCatalogKey(
  key: InvitationBenefitKey,
): `invitation.benefit.${InvitationBenefitKey}` {
  return `invitation.benefit.${key}`;
}
