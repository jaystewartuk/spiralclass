import type { AppLocale } from "../i18n/locales";

// The Terms of Service, as data (#178 step A5, D-196).
//
// Two authored documents: the English one, which is the text that applies,
// and a Spanish translation of it. They are held here, beside the privacy
// policy, rather than in the per-locale string catalog: legal text is
// translated by a person or not at all (D-81, D-128, D-196), and a catalog is
// where machine translation of legal text has already happened once (D-128).
// apps/web/src/app/terms/page.tsx renders them and holds no copy of its own.
//
// A translation records which English version it translates. When the English
// changes, `termsDocumentFor` stops serving the translation as current — the
// reader gets the current English with a line saying the translation is being
// updated — until the translation is redone and its `translates` moved on.
// That keeps an urgent change to the terms from waiting on a translator,
// without ever presenting an out-of-date translation as the terms.

/** A run of a paragraph. Strings are the document's own words. */
export type TermsInline =
  | string
  /** The support address, as a mailto link. */
  | { kind: "contactEmail" }
  /** A link to the privacy policy, with the words that carry it. */
  | { kind: "privacyLink"; text: string }
  /** Words shown only when card payments (Stripe) are configured. */
  | { kind: "ifStripe"; text: string };

export type TermsSection = {
  /** The cancellation clause, which other surfaces deep-link to. */
  anchor?: "cancellationPolicy";
  heading: string;
  paragraphs: readonly (readonly TermsInline[])[];
};

export type TermsDocument = {
  lang: AppLocale;
  /** The English text's version (its effective date). */
  version?: string;
  /** For a translation: the English version it translates. */
  translates?: string;
  title: string;
  lastUpdated: string;
  /** The link to the other document, in that document's own language. */
  switchTo: { label: string; locale: AppLocale };
  sections: readonly TermsSection[];
};

/** The English text's version: the date it last changed. */
export const TERMS_VERSION = "2026-07-10";

export const ENGLISH_TERMS: TermsDocument = {
  lang: "en",
  version: TERMS_VERSION,
  title: "Terms of Service",
  lastUpdated: "Last updated: July 10, 2026",
  switchTo: { label: "Español", locale: "es" },
  sections: [
    {
      heading: "1. Identity",
      paragraphs: [
        [
          "SpiralClass (the “Platform”) provides scheduling, payment, and communication tools to independent teachers (“Teachers”) and their students (“Students”). The Platform is not an education provider: the class agreement is directly between the Teacher and the Student.",
        ],
      ],
    },
    {
      heading: "2. Acceptance",
      paragraphs: [
        [
          "By creating an account, purchasing a class package, or using any feature of the Platform, you accept these Terms. If you don't agree, don't use the service.",
        ],
      ],
    },
    {
      heading: "3. Accounts and eligibility",
      paragraphs: [
        [
          "You must be at least 18 years old to sign up as a Teacher. Students under 18 may use the service under the supervision of a parent or legal guardian. The Platform may decline or suspend an account at any time, without prior notice, where there is reasonable suspicion of fraud, abuse, or breach of these Terms.",
        ],
      ],
    },
    {
      heading: "4. Payments",
      paragraphs: [
        [
          "Payments are processed through external providers (",
          { kind: "ifStripe", text: "Stripe and " },
          "Wise). The Platform is a facilitator: funds are transferred to the Teacher's account net of provider fees. The Platform does not store card or bank-account information.",
        ],
        [
          "Class packages are charged in advance. The number of classes, their duration, and the price are shown before payment.",
        ],
        [
          "Teachers may additionally subscribe to a recurring paid plan (monthly or annual) to unlock additional Platform features. These subscriptions renew automatically at the end of each billing period unless canceled before the renewal date; cancellation takes effect at the end of the current period and does not refund the period already in progress. Every new Teacher gets a free trial period; at its end the account automatically falls to the free plan unless a paid plan is active.",
        ],
      ],
    },
    {
      anchor: "cancellationPolicy",
      heading: "5. Cancellations and refunds",
      paragraphs: [
        [
          "Cancellations follow the 24-hour rule: a class canceled less than 24 hours before its scheduled time is deducted from the package and is not refundable. A class canceled with 24+ hours' notice releases the class back to the package and may be rescheduled, subject to the Teacher's availability.",
        ],
        [
          "This advance-cancellation/reschedule benefit is capped at one schedule change per class in the package (the same pool a direct reschedule draws from). Once that pool is spent, even a 24+-hour cancellation no longer releases the class; the Student may let it ride or ask the Teacher to release it manually.",
        ],
        [
          "Refunds: a class that was not delivered (canceled by the Teacher and not rescheduled) may be refunded at the Teacher's discretion. The Platform facilitates refunds through the original payment provider; provider fees are not refunded.",
        ],
      ],
    },
    {
      heading: "6. Acceptable use",
      paragraphs: [
        [
          "You may not: (a) use the Platform for illegal or fraudulent purposes; (b) harass, threaten, or discriminate against others; (c) attempt to access other accounts or breach the service's security; (d) automate use of the Platform without written authorization; (e) resell or transfer your account.",
        ],
      ],
    },
    {
      heading: "7. Suspension and termination",
      paragraphs: [
        [
          "You may close your account at any time by contacting ",
          { kind: "contactEmail" },
          ". The Platform may suspend or close an account for breach of these Terms. Paid but undelivered classes are handled per Section 5.",
        ],
      ],
    },
    {
      heading: "8. Intellectual property",
      paragraphs: [
        [
          "Materials that a Teacher uploads to the Platform (class plans, exercises, audio, video) are the Teacher's property. The Platform receives a limited, non-exclusive license to store and deliver those materials to the Teacher's Students. The SpiralClass brand, site, and code are the Platform's property.",
        ],
      ],
    },
    {
      heading: "9. Limitation of liability",
      paragraphs: [
        [
          "The Platform is provided “as is”. To the maximum extent permitted by law, the Platform is not liable for indirect damages, lost profits, or data loss. The Platform's total liability to any user for any claim shall not exceed the amount paid by that user to the Platform in the 12 months preceding the claim.",
        ],
      ],
    },
    {
      heading: "10. Governing law",
      paragraphs: [
        [
          "These Terms are governed by the laws of England and Wales. Disputes will be resolved before the courts of England and Wales, with the parties waiving any other jurisdiction that might apply. This does not remove any mandatory consumer protections a Student is entitled to under the law of their country of residence.",
        ],
      ],
    },
    {
      heading: "11. Changes to these Terms",
      paragraphs: [
        [
          "We may update these Terms when necessary. Material changes will be announced by email to active users at least 15 days before the effective date. Continued use after the effective date constitutes acceptance of the updated version.",
        ],
      ],
    },
    {
      heading: "12. Video calls and live captions",
      paragraphs: [
        [
          "Classes are conducted over video call. If you or your teacher turn on live captions, the speaker's audio is sent in real time to a third-party speech-recognition provider and a third-party AI translation provider, solely to generate the translated text shown on screen; that audio is not stored or used for any other purpose. Captioning your own voice requires your explicit consent, which you can give or withdraw at any time from your account settings — see our ",
          { kind: "privacyLink", text: "privacy notice" },
          " for more detail.",
        ],
      ],
    },
    {
      heading: "13. Contact",
      paragraphs: [
        [
          "Questions? Email ",
          { kind: "contactEmail" },
          ". See also our ",
          { kind: "privacyLink", text: "privacy notice" },
          ".",
        ],
      ],
    },
  ],
};

export const SPANISH_TERMS: TermsDocument = {
  lang: "es",
  translates: "2026-07-10",
  title: "Términos y condiciones",
  lastUpdated: "Última actualización: 10 de julio de 2026",
  switchTo: { label: "English", locale: "en" },
  sections: [
    {
      heading: "1. Identidad",
      paragraphs: [
        [
          "SpiralClass (en adelante, “la Plataforma”) provee herramientas de agendamiento, cobro y comunicación a maestras independientes (“Maestras”) y sus estudiantes (“Estudiantes”). La Plataforma no es proveedora de servicios educativos: el contrato de clases es directamente entre la Maestra y la Estudiante.",
        ],
      ],
    },
    {
      heading: "2. Aceptación",
      paragraphs: [
        [
          "Al crear una cuenta, comprar un paquete de clases o usar cualquier función de la Plataforma, aceptas estos Términos. Si no estás de acuerdo, no uses el servicio.",
        ],
      ],
    },
    {
      heading: "3. Cuentas y elegibilidad",
      paragraphs: [
        [
          "Debes tener al menos 18 años para registrarte como Maestra. Las Estudiantes menores de edad pueden usar el servicio bajo la supervisión de un padre, madre o tutor legal. La Plataforma puede rechazar o suspender una cuenta en cualquier momento, sin previo aviso, cuando exista sospecha razonable de fraude, abuso o incumplimiento de estos Términos.",
        ],
      ],
    },
    {
      heading: "4. Pagos",
      paragraphs: [
        [
          "Los pagos se procesan a través de proveedores externos (",
          { kind: "ifStripe", text: "Stripe y " },
          "Wise). La Plataforma actúa como facilitadora: el dinero se transfiere a la cuenta de la Maestra, descontando comisiones del proveedor de pagos. La Plataforma no almacena información de tarjetas ni de cuentas bancarias.",
        ],
        [
          "Los paquetes de clases se cobran por adelantado. La cantidad de clases, su duración y el precio se muestran antes del pago.",
        ],
        [
          "Las Maestras pueden además suscribirse a un plan de pago recurrente (mensual o anual) para desbloquear funciones adicionales de la Plataforma. Estas suscripciones se renuevan automáticamente al final de cada periodo salvo que se cancelen antes de la fecha de renovación; la cancelación aplica a partir del siguiente periodo y no genera reembolso del periodo ya iniciado. Toda nueva Maestra recibe un periodo de prueba sin costo; al finalizar, la cuenta pasa automáticamente al plan gratuito si no se activa un plan de pago.",
        ],
      ],
    },
    {
      anchor: "cancellationPolicy",
      heading: "5. Cancelaciones y reembolsos",
      paragraphs: [
        [
          "Las cancelaciones siguen la regla de 24 horas: una clase cancelada con menos de 24 horas de anticipación se descuenta del paquete y no es reembolsable. Una clase cancelada con anticipación de 24 horas o más libera la clase de vuelta al paquete y puede reagendarse, sujeto a la disponibilidad de la Maestra.",
        ],
        [
          "Este beneficio de cancelación/reagendamiento con anticipación está limitado a un cambio por cada clase del paquete (la misma bolsa que usa un reagendamiento directo). Una vez agotada esa bolsa, incluso una cancelación con 24 horas o más de anticipación deja de liberar la clase; la Estudiante puede optar por dejarla correr o pedirle a la Maestra que la libere manualmente.",
        ],
        [
          "Reembolsos: una clase no impartida (cancelada por la Maestra y no reagendada) puede reembolsarse a discreción de la Maestra. La Plataforma facilita el reembolso a través del proveedor de pagos original; las comisiones del proveedor no se reembolsan.",
        ],
      ],
    },
    {
      heading: "6. Uso aceptable",
      paragraphs: [
        [
          "No está permitido: (a) usar la Plataforma para fines ilegales o fraudulentos; (b) acosar, amenazar o discriminar a otras personas; (c) intentar acceder a cuentas ajenas o vulnerar la seguridad del servicio; (d) automatizar el uso de la Plataforma sin autorización escrita; (e) revender o ceder tu cuenta.",
        ],
      ],
    },
    {
      heading: "7. Suspensión y terminación",
      paragraphs: [
        [
          "Puedes cerrar tu cuenta en cualquier momento contactando a ",
          { kind: "contactEmail" },
          ". La Plataforma puede suspender o cerrar una cuenta por incumplimiento de estos Términos. Las clases pagadas y aún no impartidas se procesan según la Sección 5.",
        ],
      ],
    },
    {
      heading: "8. Propiedad intelectual",
      paragraphs: [
        [
          "Los materiales que cada Maestra sube a la Plataforma (planes de clase, ejercicios, audio, video) son propiedad de la Maestra. La Plataforma recibe una licencia limitada y no exclusiva para almacenar y entregar esos materiales a las Estudiantes de la Maestra. La marca SpiralClass, su sitio y su código son propiedad de la Plataforma.",
        ],
      ],
    },
    {
      heading: "9. Limitación de responsabilidad",
      paragraphs: [
        [
          "La Plataforma se ofrece “tal como está”. En la máxima medida permitida por la ley, la Plataforma no es responsable por daños indirectos, lucro cesante o pérdida de datos. La responsabilidad total de la Plataforma frente a cualquier reclamo no excederá el monto pagado a la Plataforma por la usuaria en los 12 meses anteriores al reclamo.",
        ],
      ],
    },
    {
      heading: "10. Ley aplicable",
      paragraphs: [
        [
          "Estos Términos se rigen por las leyes de Inglaterra y Gales. Las controversias se resolverán ante los tribunales de Inglaterra y Gales, renunciando las partes a cualquier otro fuero que pudiera corresponderles. Esto no elimina las protecciones que la ley del país de residencia de una Estudiante le otorgue de forma obligatoria como consumidora.",
        ],
      ],
    },
    {
      heading: "11. Cambios a estos Términos",
      paragraphs: [
        [
          "Podemos actualizar estos Términos cuando sea necesario. Los cambios significativos se anunciarán por correo a las usuarias activas con al menos 15 días de anticipación. El uso continuado después de la fecha de entrada en vigor constituye aceptación de la versión actualizada.",
        ],
      ],
    },
    {
      heading: "12. Videollamadas y subtítulos en vivo",
      paragraphs: [
        [
          "Las clases se imparten por videollamada. Si tú o tu maestra activan los subtítulos en vivo, el audio de quien habla se envía en tiempo real a un proveedor externo de reconocimiento de voz y a un proveedor externo de traducción con inteligencia artificial, únicamente para generar el texto traducido en pantalla; ese audio no se almacena ni se usa para ningún otro fin. Subtitular tu propia voz requiere tu consentimiento explícito, otorgable o revocable en cualquier momento desde la configuración de tu cuenta — consulta nuestro ",
          { kind: "privacyLink", text: "aviso de privacidad" },
          " para más detalle.",
        ],
      ],
    },
    {
      heading: "13. Contacto",
      paragraphs: [
        [
          "¿Dudas? Escribe a ",
          { kind: "contactEmail" },
          ". Consulta también nuestro ",
          { kind: "privacyLink", text: "aviso de privacidad" },
          ".",
        ],
      ],
    },
  ],
};

/**
 * The translations that exist, by the locale they are written for. Legal text
 * is translated by a person (D-196); adding one is an entry here, and the
 * hreflang set and the page follow.
 */
const TRANSLATIONS: Readonly<Partial<Record<AppLocale, TermsDocument>>> = {
  es: SPANISH_TERMS,
};

/**
 * The document to show a reader of `locale`, and whether a translation exists
 * but is out of date. A locale with no translation gets the English text,
 * which is the one that applies.
 */
export function termsDocumentFor(locale: string): {
  document: TermsDocument;
  translationOutdated: boolean;
} {
  return chooseTermsDocument(locale, ENGLISH_TERMS, TRANSLATIONS);
}

/** The rule itself, over any English text and translations, so it can be
 * tested with a translation that is behind. */
export function chooseTermsDocument(
  locale: string,
  english: TermsDocument,
  translations: Readonly<Partial<Record<string, TermsDocument>>>,
): { document: TermsDocument; translationOutdated: boolean } {
  const translation = translations[locale];
  if (!translation) return { document: english, translationOutdated: false };
  if (translation.translates !== english.version) {
    return { document: english, translationOutdated: true };
  }
  return { document: translation, translationOutdated: false };
}

/** The languages the terms can be read in today: English, plus each
 * translation that is current. What the page advertises in hreflang. */
export function termsLanguages(): AppLocale[] {
  const current = (Object.keys(TRANSLATIONS) as AppLocale[]).filter(
    (locale) => !termsDocumentFor(locale).translationOutdated,
  );
  return ["en", ...current];
}
