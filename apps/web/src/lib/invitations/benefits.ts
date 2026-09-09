// The value proposition shown to an invited student. The benefit key list and
// its catalog-key helper are shared cross-platform (@spiralclass/shared) so the
// email, web accept page and mobile accept screen can't drift; re-exported here
// so existing `@/lib/invitations/benefits` imports keep working.
import {
  CORE_BENEFIT_KEYS,
  benefitCatalogKey,
  type InvitationBenefitKey,
  type LanguageCode,
} from "@spiralclass/shared";

export { CORE_BENEFIT_KEYS, benefitCatalogKey, type InvitationBenefitKey };

// Plain-language benefit copy for the EMAIL body, which renders outside the
// React catalog (a string template, like every other transactional email). Kept
// here beside the key list so the two can't drift. Email copy is authored es/en
// only (the same convention the notification templates follow); any other
// language code (e.g. `fr`) falls back to English.
export function benefitEmailLines(includeMessaging: boolean, languageCode: LanguageCode): string[] {
  const es = languageCode === "es_MX";
  const lines: Record<InvitationBenefitKey, { es: string; en: string }> = {
    scheduling: {
      es: "Agenda y reagenda tus clases en segundos.",
      en: "Book and reschedule your classes in seconds.",
    },
    homework: {
      es: "Recibe tu tarea y materiales en un solo lugar.",
      en: "Get your homework and materials in one place.",
    },
    aiMaterials: {
      es: "Materiales de estudio personalizados con IA.",
      en: "Personalized AI-generated study materials.",
    },
    notifications: {
      es: "Recordatorios para que no se te pase ninguna clase.",
      en: "Reminders so you never miss a class.",
    },
    messaging: {
      es: "Mensajería directa con tu maestra.",
      en: "Message your teacher directly.",
    },
  };
  const keys: InvitationBenefitKey[] = [
    ...CORE_BENEFIT_KEYS,
    ...(includeMessaging ? (["messaging"] as const) : []),
  ];
  return keys.map((k) => (es ? lines[k].es : lines[k].en));
}
