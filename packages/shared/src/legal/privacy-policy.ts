// The privacy policy, as structured data rather than markup.
//
// WHY DATA AND NOT JSX. Three reasons, in order of how much they matter.
//   1. Web and mobile render the SAME document. They previously rendered two
//      different ones, and the mobile copy named a different controller under a
//      different country's law. One source removes that class of bug outright.
//   2. Legal copy is authored in English and is NOT machine-translated —
//      the standing rule from D-81. Keeping the text out of the i18n catalog is
//      how that rule is enforced structurally instead of remembered. (The page
//      it replaces broke exactly this: its Spanish and English variants were
//      keyed `…privacy.es.*` / `…privacy.en.*` inside a per-locale catalog, so
//      `catalog.fr.ts` had machine-translated BOTH variants into French and a
//      French reader saw a link labelled "Español" that rendered in French.)
//   3. `src/app/privacy-notice/page.tsx` is on the `i18n/no-literal-string`
//      allowlist, so it may not carry inline copy. Data in a `.ts` module keeps
//      that page clean without inventing 240 catalog entries of translated law.
//
// SCOPE OF THIS DOCUMENT. UK GDPR and the Data Protection Act 2018 are the
// governing regime, matching the Terms, which are already governed by the laws
// of England and Wales, and matching the platform Stripe entity, which is
// UK-established (D-58). It replaced an `Aviso de privacidad` written under Mexico's
// LFPDPPP, which described a controller and a rights regime that do not apply
// to a UK-established controller.

import { SUBPROCESSORS_REVIEWED } from "./subprocessors";

/** The date this document was last substantively changed. */
export const PRIVACY_POLICY_LAST_UPDATED = "2026-08-25";

/** Re-exported so a renderer needs one import to show both dates. */
export { SUBPROCESSORS_REVIEWED };

export const PRIVACY_CONTACT_EMAIL = "privacy@spiralclass.com";

export const CONTROLLER = {
  name: "Jay Stewart",
  tradingAs: "SpiralClass",
  establishment: "United Kingdom",
  email: PRIVACY_CONTACT_EMAIL,
} as const;

/** The supervisory authority a UK data subject may complain to. */
export const SUPERVISORY_AUTHORITY = {
  name: "Information Commissioner's Office",
  url: "https://ico.org.uk/make-a-complaint/",
} as const;

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

export type PolicyBlock =
  | { kind: "text"; text: string }
  | { kind: "list"; items: readonly string[] }
  | { kind: "basisTable"; rows: readonly LawfulBasisRow[] }
  | { kind: "retentionTable"; rows: readonly RetentionRow[] }
  | { kind: "subprocessors" }
  | { kind: "contact" };

export type LawfulBasisRow = {
  purpose: string;
  data: string;
  /** The UK GDPR Article 6 basis, named the way the ICO names it. */
  basis: "Contract" | "Legitimate interests" | "Consent" | "Legal obligation";
  /** Present only where the basis is legitimate interests, which requires it. */
  interest?: string;
};

export type RetentionRow = { what: string; howLong: string };

export type PolicySection = {
  id: string;
  heading: string;
  blocks: readonly PolicyBlock[];
};

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export const PRIVACY_POLICY_TITLE = "Privacy policy";

/**
 * Every visible label inside the policy article. They live here rather than in
 * the i18n catalog for the same reason the prose does: the document is one
 * English artefact, and a translated column header sitting above untranslated
 * legal text reads as a half-finished page. It also keeps
 * `privacy-notice/page.tsx` free of inline copy, which its
 * `i18n/no-literal-string` allowlist membership requires.
 */
export const PRIVACY_LABELS = {
  lastUpdated: "Last updated",
  basisPurpose: "What we do",
  basisData: "Data involved",
  basisBasis: "Lawful basis",
  retentionWhat: "What",
  retentionHowLong: "How long",
  supplierName: "Supplier",
  supplierPurpose: "What for",
  supplierData: "What they see",
  supplierLocation: "Where",
  suppliersCore: "Suppliers we use for everyone",
  suppliersGated:
    "Suppliers used only when a specific feature is switched on. They receive nothing at all while it is off.",
  suppliersReviewed: "Supplier locations last reviewed",
  controllerLine: "Data controller",
} as const;

export const PRIVACY_POLICY_INTRO =
  "This policy explains what SpiralClass does with personal data, why, and what you can ask us to do about it. It is written to be read, not to be survived — if any part of it is unclear, ask and we will explain it in plainer words.";

export const PRIVACY_POLICY_SECTIONS: readonly PolicySection[] = [
  {
    id: "who-we-are",
    heading: "Who we are",
    blocks: [
      {
        kind: "text",
        text: `SpiralClass is operated by ${CONTROLLER.name}, established in the ${CONTROLLER.establishment} and trading as ${CONTROLLER.tradingAs}. For everything described here we are the data controller: we decide what is collected and why.`,
      },
      {
        kind: "text",
        text: "Because we are established in the United Kingdom, UK GDPR and the Data Protection Act 2018 govern this policy. Where we serve people in the European Economic Area, the EU GDPR applies to that processing and gives you the same rights. Our Terms are governed by the laws of England and Wales.",
      },
      {
        kind: "text",
        text: "Two kinds of people use SpiralClass, and this policy covers both. Teachers hold an account and run their business on it. Students book, pay for and attend classes. A teacher decides what to teach and what to record about a student's learning; we provide the software that makes that possible and we hold the data on their behalf as well as our own.",
      },
    ],
  },
  {
    id: "what-we-collect",
    heading: "What we collect",
    blocks: [
      { kind: "text", text: "We collect only what the product needs to work." },
      {
        kind: "list",
        items: [
          "Account details — your name, email address, the language you prefer, your time zone, and an optional phone number. A teacher also has a public profile: a photo, a short biography, and an optional intro video they record themselves.",
          "Class records — what was booked, when, whether it happened, what was taught, and any notes or homework attached to it.",
          "Payment records — the amount, date, currency and status of each payment, and the identifiers our payment providers give us. We never see or store your full card number. A teacher who takes payment by direct transfer also stores the payee details students pay into, such as an account number or an IBAN; those are the teacher's own, and a student never gives us their bank credentials.",
          "Things you write and upload — messages between a teacher and a student, homework answers and files, lesson materials, and images.",
          "Technical data — your IP address, device and browser, and the pages you visit. We use it to keep the service working and to understand which parts of the product people actually use.",
          "Live class audio and video — carried between the two participants while the class is running. It is not recorded or stored unless a teacher starts a recording, and a student's voice is only ever analysed for learning insights where that student (or their parent or guardian, if they are under 18) has given consent for it, recorded against that teacher.",
        ],
      },
      {
        kind: "text",
        text: "We do not buy personal data from anyone, we do not sell it to anyone, and we do not use it to train anybody's AI models.",
      },
    ],
  },
  {
    id: "why-we-use-it",
    heading: "Why we use it, and our lawful basis",
    blocks: [
      {
        kind: "text",
        text: "UK GDPR requires us to have a specific lawful reason for each thing we do with your data. Ours are these.",
      },
      {
        kind: "basisTable",
        rows: [
          {
            purpose: "Run your account, your bookings and your classes",
            data: "Account details, class records",
            basis: "Contract",
          },
          {
            purpose: "Take payment and pay teachers out",
            data: "Payment records, name, email",
            basis: "Contract",
          },
          {
            purpose: "Send booking confirmations, reminders and service messages",
            data: "Email address, phone number, class records",
            basis: "Contract",
          },
          {
            purpose: "Keep the service secure, prevent abuse, and diagnose faults",
            data: "Technical data, error reports",
            basis: "Legitimate interests",
            interest: "Keeping a service that handles money and personal data safe and working.",
          },
          {
            purpose: "Understand which parts of the product are used, and improve them",
            data: "Technical data, actions taken in the product",
            basis: "Legitimate interests",
            interest:
              "Improving a product used by a small number of people, where guessing would waste their time as well as ours.",
          },
          {
            purpose: "Record where a new student first came from, so a teacher can see what works",
            data: "A first-touch attribution cookie and a hashed visitor identifier",
            basis: "Legitimate interests",
            interest:
              "Letting an independent teacher find out which of their own efforts actually brought them students.",
          },
          {
            purpose: "Record, transcribe or analyse a class, and produce learning insights from it",
            data: "Class audio, transcripts, learning notes",
            basis: "Consent",
          },
          {
            purpose: "Live captions and translation during a class",
            data: "The speaker's audio while the feature is on",
            basis: "Consent",
          },
          {
            purpose: "Keep financial and tax records",
            data: "Payment records, invoices",
            basis: "Legal obligation",
          },
        ],
      },
      {
        kind: "text",
        text: "Where we rely on consent you can withdraw it at any time, and withdrawing it is as easy as giving it. Where we rely on legitimate interests you can object, and we will stop unless we have a compelling reason not to that overrides your rights.",
      },
    ],
  },
  {
    id: "ai-features",
    heading: "AI features, and what they do with your data",
    blocks: [
      {
        kind: "text",
        text: "Several parts of SpiralClass use AI models. We think you should know exactly which, and exactly what each one sees.",
      },
      {
        kind: "list",
        items: [
          "Lesson materials — when a teacher asks the product to draft or edit a teaching material, the text of that material and the teacher's own lesson template are sent to Anthropic. Student data is not included.",
          "Live captions — when a teacher turns captions on during a class, that teacher's speech is transcribed by Deepgram and translated by Anthropic, in real time. Nothing is stored: the captions exist only while the class is running.",
          "Class transcription and learning insights — where a student has consented (or their parent or guardian has, for a student under 18), each speaker's audio from that class is transcribed by Deepgram and the transcript is read by Anthropic to suggest what to work on next. The audio itself is deleted as soon as it has been transcribed, unless the teacher has chosen to keep it so the class can be played back. Every suggestion is a draft the teacher reviews before it counts for anything.",
          "Homework review — when a teacher asks for an AI first pass on a homework answer, that answer is sent to Anthropic. It produces a draft for the teacher to review; it never reaches the student without the teacher.",
          "Intro-video coaching — a teacher's own promotional video, which is public, is transcribed and reviewed to give them feedback on it. No student is involved.",
          "Promotional posts and images — text and images are generated from a teacher's own public profile, by Anthropic and by Google's Gemini model respectively. No student data is used.",
        ],
      },
      {
        kind: "text",
        text: "No AI feature makes a decision about you that has a legal or similarly significant effect. Every one of them produces a draft that a person reviews. Nothing here is used to train anybody's AI models.",
      },
    ],
  },
  {
    id: "children",
    heading: "Children and students under 18",
    blocks: [
      {
        kind: "text",
        text: "Language teaching involves young people, so this deserves its own section rather than a clause buried elsewhere.",
      },
      {
        kind: "text",
        text: "A teacher records whether a student is a minor. Where a student is a minor, the features that capture a student's voice or produce learning analysis about them require a parent's or guardian's consent, recorded against that pairing — the student's own consent is not accepted and is not sufficient. Those features are off by default for everyone: with no consent recorded, nothing is captured.",
      },
      {
        kind: "text",
        text: "An SpiralClass account is intended to be held by an adult. If you believe a child has given us personal data without the right permission, write to us and we will delete it.",
      },
    ],
  },
  {
    id: "who-we-share-with",
    heading: "Who else sees your data",
    blocks: [
      {
        kind: "text",
        text: "We use other companies to run parts of the service. They act on our instructions and may not use your data for their own purposes. This is the full list, maintained in the product's source code rather than typed into this page, so a new supplier cannot be added without appearing here.",
      },
      { kind: "subprocessors" },
      {
        kind: "text",
        text: "We also share data where we are legally required to, and we may share it with a professional adviser where necessary. If the business were ever sold or transferred, your data would move with it and you would be told.",
      },
    ],
  },
  {
    id: "transfers",
    heading: "Where your data goes",
    blocks: [
      {
        kind: "text",
        text: "Most of our infrastructure is in the United States. The application servers run in Chicago, the database in Ohio, and our error tracking and analytics are on their providers' United States regions. If you are in the United Kingdom or the European Economic Area, your data is therefore transferred out of it.",
      },
      {
        kind: "text",
        text: "Those transfers are made under the UK International Data Transfer Addendum or the European Commission's Standard Contractual Clauses, as incorporated in each supplier's data processing terms, or under an adequacy decision where one covers the supplier. If you want to know which applies to a particular supplier, ask and we will tell you.",
      },
    ],
  },
  {
    id: "cookies",
    heading: "Cookies and similar technologies",
    blocks: [
      {
        kind: "text",
        text: "We set a small number of cookies. Some are strictly necessary — they keep you signed in, protect forms against cross-site request forgery, and remember your chosen language. The service does not work without them.",
      },
      {
        kind: "text",
        text: "Two are not strictly necessary. Our analytics provider sets cookies to recognise a returning visitor and to record how the product is used, including session replay. We also set two small marketing cookies: one remembers where you first arrived from, so a teacher can see which of their own efforts brought a student to them, and one carries an anonymous visitor identifier. That identifier is hashed before it is stored, and we deliberately do not record your IP address, your browser's user agent or the page you came from alongside it. We rely on legitimate interests for all of these, as described above.",
      },
      {
        kind: "text",
        text: "You can refuse or delete any of these in your browser settings, and you can object to the non-essential ones by writing to us. Refusing the strictly necessary ones will stop you being able to sign in.",
      },
    ],
  },
  {
    id: "retention",
    heading: "How long we keep it",
    blocks: [
      {
        kind: "text",
        text: "We keep data for as long as it is doing a job, and then we get rid of it.",
      },
      {
        kind: "retentionTable",
        rows: [
          {
            what: "Your account and profile",
            howLong: "While the account is open, then deleted or anonymised after you close it",
          },
          {
            what: "Class and booking records",
            howLong: "While the account is open; anonymised when it closes",
          },
          {
            what: "Payment and invoice records",
            howLong:
              "Six years, to meet UK tax and accounting obligations, even after an account closes",
          },
          {
            what: "Messages, homework and materials",
            howLong: "While the account is open, then deleted with it",
          },
          {
            what: "Your notification history",
            howLong: "Visible to you for 90 days",
          },
          {
            what: "Error reports and analytics",
            howLong: "As set by our providers' own retention windows, typically under 12 months",
          },
          {
            what: "Live class audio and video",
            howLong:
              "Not stored, unless a teacher records the class — and a recording is audio only, never video",
          },
          {
            what: "Audio captured for learning insights",
            howLong:
              "Deleted as soon as it has been transcribed, unless the teacher chose to keep it so the class can be played back",
          },
          {
            what: "A class recording a teacher started, and its transcript",
            howLong:
              "While the teacher's account is open, then deleted with it. Ask us and we will delete it sooner",
          },
        ],
      },
    ],
  },
  {
    id: "your-rights",
    heading: "Your rights, and how to use them",
    blocks: [
      {
        kind: "text",
        text: "Under UK GDPR you have the following rights. They are free to use, and we will answer within one month.",
      },
      {
        kind: "list",
        items: [
          "Access — get a copy of the personal data we hold about you.",
          "Rectification — have anything inaccurate corrected.",
          "Erasure — have your data deleted, where we have no overriding reason to keep it.",
          "Restriction — have us pause what we do with it while a question is resolved.",
          "Portability — receive the data you gave us in a machine-readable format, or have it sent elsewhere.",
          "Objection — object to processing we base on legitimate interests, including the analytics and attribution described above.",
          "Withdraw consent — for anything we do on the basis of your consent, at any time.",
        ],
      },
      {
        kind: "text",
        text: "You do not have to write to us for the first two of these. Signed in, you can download everything we hold about you from your account settings, and you can request deletion of your account from the same place. Both are self-serve and take effect without us reading your reasons.",
      },
      {
        kind: "text",
        text: `If you are unhappy with how we have handled your data, you can complain to the ${SUPERVISORY_AUTHORITY.name}, the United Kingdom's supervisory authority, at ${SUPERVISORY_AUTHORITY.url}. We would rather you told us first, so we can put it right.`,
      },
    ],
  },
  {
    id: "security",
    heading: "How we protect it",
    blocks: [
      {
        kind: "text",
        text: "Traffic is encrypted in transit. There are no passwords to steal — signing in is by a one-time code or link, or through Google — and card details never reach our servers, because Stripe collects them directly. The most sensitive things we do store, a teacher's payment-provider credentials and the token that connects their calendar, are separately encrypted at rest under a key held outside the database. Our database is a managed service reachable only over an encrypted connection. Administrative access requires a second factor, and every administrative action taken on an account is written to an audit log.",
      },
      {
        kind: "text",
        text: "No system is perfectly safe. If a breach ever put your rights or freedoms at risk we will tell you, and we will report it to the Information Commissioner's Office as the law requires.",
      },
    ],
  },
  {
    id: "changes",
    heading: "Changes to this policy",
    blocks: [
      {
        kind: "text",
        text: "When this policy changes we update the date at the top. If a change materially affects your rights we will tell you directly rather than relying on you to re-read the page.",
      },
    ],
  },
  {
    id: "contact",
    heading: "Contact us",
    blocks: [
      {
        kind: "text",
        text: "For anything in this policy, including a request to use one of the rights above, write to us. A person reads it.",
      },
      { kind: "contact" },
    ],
  },
];
