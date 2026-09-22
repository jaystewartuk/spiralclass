// Canned sample transcript for the marketing live-captions demo
// (components/marketing/captions-demo.tsx). These bilingual lines are
// demonstration CONTENT — a Spanish teacher utterance paired with the live
// English translation the student reads — not localizable UI chrome. They
// deliberately live in this `.ts` data file (not the `.tsx` component) so the
// i18n-guard's JSX-literal scan doesn't treat sample sentences as untranslated
// app copy. The surrounding labels (badge, speaker/translation labels, replay)
// ARE real UI and come from the i18n catalog, passed in as props.

export type CaptionLine = {
  /** What the teacher says, in Spanish. */
  es: string;
  /** The live English translation the student reads. */
  en: string;
  /** Delay in ms before this line appears, relative to the previous one. */
  delayMs: number;
};

export const CAPTION_LINES: CaptionLine[] = [
  {
    es: "Hoy vamos a practicar el pretérito.",
    en: "Today we're going to practice the past tense.",
    delayMs: 500,
  },
  {
    es: "¿Qué hiciste el fin de semana?",
    en: "What did you do over the weekend?",
    delayMs: 2400,
  },
  {
    es: "Muy bien, pero se dice «fui», no «fue».",
    en: "Great, but you say “fui,” not “fue.”",
    delayMs: 2800,
  },
  {
    es: "Escucha la pronunciación otra vez.",
    en: "Listen to the pronunciation again.",
    delayMs: 2400,
  },
  {
    es: "¡Perfecto! Lo estás diciendo muy natural.",
    en: "Perfect! You're saying it very naturally.",
    delayMs: 2600,
  },
];
