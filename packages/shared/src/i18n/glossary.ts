import type { AppLocale } from "./locales";

// The glossary for each language (#178 step D4): how the product addresses
// its reader, the one word it uses for each thing it talks about, and the
// words it must never use. Translators — and the sessions writing the help
// centre — read this; i18n.test.ts holds each catalog to it.
//
// Typed by AppLocale, so registering a language fails the build until it has
// one. Its terms are the catalog's own: a word here that the catalog does not
// use is a glossary describing some other product.

export type Concept = "teacher" | "student" | "class" | "package" | "booking" | "availability";

export type Glossary = {
  /** How the reader is addressed, and why. */
  address: string;
  /** The word for each thing, as the catalog uses it. */
  terms: Record<Concept, string>;
  /** Words that must not appear in this language's catalog, each with why. */
  forbidden: readonly { pattern: RegExp; why: string }[];
};

export const GLOSSARY: Record<AppLocale, Glossary> = {
  en: {
    address: "“you”, plain and direct.",
    terms: {
      teacher: "teacher",
      student: "student",
      class: "class",
      package: "package",
      booking: "booking",
      availability: "availability",
    },
    forbidden: [],
  },
  es: {
    address:
      "“tú” to the reader, and “ustedes” for more than one — Latin American " +
      "Spanish, with no “vosotros” (D-195).",
    terms: {
      teacher: "profe",
      student: "alumno",
      class: "clase",
      package: "paquete",
      booking: "reserva",
      availability: "disponibilidad",
    },
    forbidden: [
      {
        pattern: /\b(vosotros|vosotras|vuestro|vuestra|vuestros|vuestras)\b/i,
        why: "Spain's plural address; the catalog is Latin American Spanish (D-195).",
      },
    ],
  },
  fr: {
    address: "“vous”, always: the formal address French product copy expects.",
    terms: {
      teacher: "professeur",
      student: "élève",
      class: "cours",
      package: "forfait",
      booking: "réservation",
      availability: "disponibilités",
    },
    forbidden: [
      {
        pattern: /\bprofes?\b/i,
        why: "Spanish. It reached the French catalog 25 times before this guard.",
      },
      {
        pattern: /(?<!\p{L})(tu|toi|tes)(?!\p{L})/u,
        why: "The informal address; French copy says “vous”.",
      },
    ],
  },
};
