// The value proposition shown to an invited student. The benefit key list and
// its catalog-key helper are shared cross-platform (@spiralclass/shared) so the
// email and the web accept page can't drift; re-exported here so existing
// `@/lib/invitations/benefits` imports keep working.
import {
  CORE_BENEFIT_KEYS,
  benefitCatalogKey,
  type InvitationBenefitKey,
  type TFunction,
} from "@spiralclass/shared";

export { CORE_BENEFIT_KEYS, benefitCatalogKey, type InvitationBenefitKey };

// The benefit lines for the EMAIL body, from the same catalog keys the accept
// page renders. This used to hold its own Spanish and English copy, so a French
// student was invited in French with the benefits listed in English.
export function benefitEmailLines(includeMessaging: boolean, t: TFunction): string[] {
  const keys: InvitationBenefitKey[] = [
    ...CORE_BENEFIT_KEYS,
    ...(includeMessaging ? (["messaging"] as const) : []),
  ];
  return keys.map((k) => t(benefitCatalogKey(k)));
}
