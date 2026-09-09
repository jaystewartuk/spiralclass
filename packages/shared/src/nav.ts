// Canonical teacher-facing information architecture. This file owns the
// *structure* — which destinations exist, how they group, and their bilingual
// labels/descriptions. It deliberately does NOT own routes: the app keeps a
// thin `NavKey -> href` resolver next to its router. Add a destination here
// once and it renders from that one definition.

import type { AppLocale } from "./i18n/locales";

export type NavLocale = AppLocale;

export type NavLabel = Record<AppLocale, string>;

// Top-level sections of the teacher experience.
//  - main:    the day-to-day task nav (the web header bar / mobile tab bar).
//  - page:    "Tu página" — the booking-page-facing tools (leads, social
//             proof, the public page itself). Their natural home, rather than
//             scattered into settings or the dashboard grid.
//  - content: "Contenido" — the teaching-content surfaces that feed the
//             AI-compose + library engine (materials, focus tags, lesson
//             templates). Promoted to their own group once the
//             cluster earned its weight, rather than buried in settings.
//  - config:  account + workspace settings.
//  - support: help and legal.
export type NavGroupKey = "main" | "page" | "content" | "config" | "support";

export type NavKey =
  // principal
  | "dashboard"
  | "calendar"
  | "classes"
  | "students"
  | "payments"
  | "messages"
  // The student-acquisition command centre (D-125). Top-level rather than
  // filed under "Tu página": getting the next student is a daily job, not a
  // settings screen, and burying it was exactly why the acquisition features
  // that already existed went unused.
  | "getStudents"
  // pagina
  | "bookingPage"
  | "publicPage"
  | "leads"
  | "testimonials"
  | "discounts"
  | "referrals"
  | "shareGroups"
  // contenido (Contenido) — the teaching-content surfaces that feed the
  // AI-compose + library engine, promoted to their own group.
  | "materials"
  | "focusTags"
  | "classContentTemplates"
  | "materialStyle"
  // config
  | "availability"
  | "blockedDates"
  | "calendarSync"
  | "packages"
  | "paymentMethods"
  | "billing"
  | "notifications"
  | "account"
  // soporte
  | "help"
  | "privacy"
  | "terms";

export type NavItem = {
  key: NavKey;
  group: NavGroupKey;
  label: NavLabel;
  // Short blurb used by card-grid presentations (the web dashboard "Tu día a
  // día" tiles and the mobile "Tu página" cards). Omitted for items that only
  // ever appear as a bare row/link.
  description?: NavLabel;
  // True when the destination lives outside the app shell (legal pages, the
  // public booking page) and should open as a plain link rather than an
  // in-app route. Each platform decides how to honour it.
  external?: boolean;
};

export const NAV_GROUP_LABELS: Record<NavGroupKey, NavLabel> = {
  main: { "es-MX": "Principal", en: "Main", fr: "Principal" },
  page: { "es-MX": "Tu página", en: "Your page", fr: "Votre page" },
  // "Materiales" over "Contenido": the per-class AI-drafted
  // Markdown panel is already titled "Contenido de la clase" ("Class
  // content") elsewhere in the product — reusing "Contenido" for this group
  // would read as the same word meaning two different things. "Materiales"
  // also matches the vocabulary the teacher who requested this group
  // actually uses ("material," not "contenido"). The internal key stays
  // `content` (not persisted anywhere; NavKey, not NavGroupKey, is what
  // Teacher.dashboardTileOrder stores) — only the label changed.
  content: { "es-MX": "Materiales", en: "Materials", fr: "Supports" },
  config: { "es-MX": "Configuración", en: "Settings", fr: "Paramètres" },
  support: { "es-MX": "Soporte", en: "Support", fr: "Assistance" },
};

export const NAV_ITEMS: NavItem[] = [
  // ---- principal ----
  {
    key: "dashboard",
    group: "main",
    label: { "es-MX": "Panel", en: "Dashboard", fr: "Tableau de bord" },
  },
  {
    key: "calendar",
    group: "main",
    label: { "es-MX": "Calendario", en: "Calendar", fr: "Calendrier" },
  },
  {
    key: "classes",
    group: "main",
    label: { "es-MX": "Clases", en: "Classes", fr: "Cours" },
    description: {
      "es-MX": "Próximas, completar, cancelar, ajustar.",
      en: "Upcoming, complete, cancel, adjust.",
      fr: "À venir, terminer, annuler, ajuster.",
    },
  },
  {
    key: "students",
    group: "main",
    label: { "es-MX": "Alumnos", en: "Students", fr: "Élèves" },
    description: {
      "es-MX": "Saldos, vencimientos y precio personalizado.",
      en: "Balances, expirations and custom pricing.",
      fr: "Soldes, échéances et tarifs personnalisés.",
    },
  },
  {
    key: "payments",
    group: "main",
    label: { "es-MX": "Pagos", en: "Payments", fr: "Paiements" },
    description: {
      "es-MX": "Recibos, parciales y reembolsos.",
      en: "Receipts, partials and refunds.",
      fr: "Reçus, paiements partiels et remboursements.",
    },
  },
  {
    key: "messages",
    group: "main",
    label: { "es-MX": "Mensajes", en: "Messages", fr: "Messages" },
    description: {
      "es-MX": "Chat de voz y texto con tus alumnos.",
      en: "Voice and text chat with your students.",
      fr: "Messagerie vocale et texte avec vos élèves.",
    },
  },
  {
    key: "getStudents",
    group: "main",
    label: { "es-MX": "Consigue alumnos", en: "Get students", fr: "Trouvez des élèves" },
    description: {
      "es-MX": "Tu plan de la semana, contenido listo y resultados.",
      en: "Your plan for the week, ready-made content and results.",
      fr: "Votre plan de la semaine, du contenu prêt et vos résultats.",
    },
  },
  // ---- pagina (Tu página) — the public booking page itself and everything
  //      that drives students to it: the page editor, social proof, leads and
  //      the growth tools. `bookingPage` (the headline/bio/photo editor) leads
  //      the group — it's the thing a teacher edits, so it belongs with "your
  //      page," not buried in settings.
  {
    key: "bookingPage",
    group: "page",
    label: { "es-MX": "Editar tu página", en: "Edit your page", fr: "Modifier votre page" },
    description: {
      "es-MX": "El titular, la descripción y la foto de tu página pública.",
      en: "The headline, description and photo on your public page.",
      fr: "Le titre, la description et la photo de votre page publique.",
    },
  },
  {
    key: "publicPage",
    group: "page",
    label: { "es-MX": "Ver página pública", en: "View public page", fr: "Voir la page publique" },
    description: {
      "es-MX": "Tu página de reservas tal como la ven tus alumnos. Se abre en tu navegador.",
      en: "Your booking page as students see it. Opens in your browser.",
      fr: "Votre page de réservation telle que la voient vos élèves. S'ouvre dans votre navigateur.",
    },
    external: true,
  },
  {
    key: "leads",
    group: "page",
    label: { "es-MX": "Interesados", en: "Leads", fr: "Prospects" },
    description: {
      "es-MX": "Personas que te escribieron desde tu página.",
      en: "People who reached out from your booking page.",
      fr: "Les personnes qui vous ont contacté depuis votre page de réservation.",
    },
  },
  {
    key: "testimonials",
    group: "page",
    label: { "es-MX": "Testimonios", en: "Testimonials", fr: "Témoignages" },
    description: {
      "es-MX": "Prueba social en tu página de reservas.",
      en: "Social proof shown on your booking page.",
      fr: "La preuve sociale affichée sur votre page de réservation.",
    },
  },
  {
    key: "discounts",
    group: "page",
    label: { "es-MX": "Códigos de descuento", en: "Discount codes", fr: "Codes de réduction" },
    description: {
      "es-MX": "Códigos promocionales para el pago.",
      en: "Promo codes students enter at checkout.",
      fr: "Codes promo que les élèves saisissent au paiement.",
    },
  },
  {
    key: "referrals",
    group: "page",
    label: { "es-MX": "Referidos", en: "Referrals", fr: "Parrainages" },
    description: {
      "es-MX": "Deja que tus alumnos traigan amigos por una recompensa.",
      en: "Let students bring friends for a reward.",
      fr: "Laissez vos élèves inviter des amis contre une récompense.",
    },
  },
  {
    // Key unchanged on purpose: it is persisted in every teacher's saved
    // dashboard layout and addressed by the mobile router. D-125 generalised
    // what it POINTS AT (Facebook groups became marketing communities), not
    // what it is called internally.
    key: "shareGroups",
    group: "page",
    label: { "es-MX": "Comunidades", en: "Communities", fr: "Communautés" },
    description: {
      "es-MX": "Dónde puedes llegar a futuros alumnos, y qué permite cada una.",
      en: "Where you can reach future students, and what each one allows.",
      fr: "Où atteindre de futurs élèves, et ce que chacune autorise.",
    },
  },
  // ---- contenido (Contenido) — teaching content, its own group ----
  {
    key: "materials",
    group: "content",
    label: { "es-MX": "Materiales", en: "Materials", fr: "Supports" },
    description: {
      "es-MX": "Biblioteca de recursos por nivel.",
      en: "Level-tagged resource library.",
      fr: "Bibliothèque de ressources classées par niveau.",
    },
  },
  {
    key: "focusTags",
    group: "content",
    // "Etiquetas"/"Tags" over "Enfoques"/"Focus tags": this
    // taxonomy grew past "what to focus a class on" (grammar/vocab/skill) to
    // also cover material format/category/theme — "focus" undersold what's
    // actually here. Levels live on their own settings screen; this is the
    // rest of the tagging layer.
    label: { "es-MX": "Etiquetas", en: "Tags", fr: "Étiquettes" },
    description: {
      "es-MX": "Categorías, formatos y temas para tus materiales y clases.",
      en: "Categories, formats, and themes for your materials and classes.",
      fr: "Catégories, formats et thèmes pour vos supports et vos cours.",
    },
  },
  {
    key: "classContentTemplates",
    group: "content",
    label: { "es-MX": "Plantillas de clase", en: "Lesson templates", fr: "Modèles de cours" },
    description: {
      "es-MX": "Estructuras de clase reutilizables que la IA sigue al generar contenido.",
      en: "Reusable lesson structures the AI follows when generating content.",
      fr: "Structures de cours réutilisables que l'IA suit pour générer le contenu.",
    },
  },
  {
    key: "materialStyle",
    group: "content",
    label: { "es-MX": "Estilo con IA", en: "AI material style", fr: "Style des supports IA" },
    description: {
      "es-MX": "Tono y estilo que la IA usa al generar tus materiales.",
      en: "The tone and style the AI uses when generating your materials.",
      fr: "Le ton et le style que l'IA emploie pour générer vos supports.",
    },
  },
  // ---- config ----
  {
    key: "availability",
    group: "config",
    label: { "es-MX": "Horario de trabajo", en: "Working hours", fr: "Heures de travail" },
    description: {
      "es-MX": "Ajusta tu agenda semanal.",
      en: "Adjust your weekly schedule.",
      fr: "Ajustez votre emploi du temps hebdomadaire.",
    },
  },
  {
    key: "blockedDates",
    group: "config",
    label: { "es-MX": "Fechas bloqueadas", en: "Blocked dates", fr: "Dates bloquées" },
    description: {
      "es-MX": "Vacaciones, festivos y días libres.",
      en: "Holidays, vacations and days off.",
      fr: "Congés, jours fériés et jours de repos.",
    },
  },
  {
    key: "calendarSync",
    group: "config",
    label: {
      "es-MX": "Sincronizar calendario",
      en: "Calendar sync",
      fr: "Synchronisation du calendrier",
    },
  },
  {
    key: "packages",
    group: "config",
    label: { "es-MX": "Paquetes", en: "Packages", fr: "Forfaits" },
  },
  {
    key: "paymentMethods",
    group: "config",
    label: { "es-MX": "Métodos de cobro", en: "Payment methods", fr: "Moyens de paiement" },
  },
  {
    key: "billing",
    group: "config",
    label: { "es-MX": "Suscripción", en: "Subscription", fr: "Abonnement" },
  },
  {
    key: "notifications",
    group: "config",
    label: { "es-MX": "Notificaciones", en: "Notifications", fr: "Notifications" },
  },
  {
    key: "account",
    group: "config",
    label: { "es-MX": "Cuenta", en: "Account", fr: "Compte" },
    description: {
      "es-MX": "Datos de la cuenta y eliminación.",
      en: "Account details and deletion.",
      fr: "Informations du compte et suppression.",
    },
  },
  // ---- soporte ----
  {
    key: "help",
    group: "support",
    label: { "es-MX": "Ayuda", en: "Help", fr: "Aide" },
    description: {
      "es-MX": "Paquetes, pagos, cancelaciones y más.",
      en: "Packages, payments, cancellations and more.",
      fr: "Forfaits, paiements, annulations et plus.",
    },
  },
  {
    key: "privacy",
    group: "support",
    label: { "es-MX": "Aviso de privacidad", en: "Privacy notice", fr: "Avis de confidentialité" },
    external: true,
  },
  {
    key: "terms",
    group: "support",
    label: {
      "es-MX": "Términos y condiciones",
      en: "Terms & conditions",
      fr: "Conditions générales",
    },
    external: true,
  },
];

// The primary destinations that belong on a bottom *tab bar* — the thumb-reach
// nav the teacher prefers on a small screen. These are the four task
// destinations surfaced as first-class tabs; the bar rounds them out with the
// notification inbox and a settings entry, which the shell composes itself (the
// inbox bell plus the /settings tree). Keep this the canonical order.
export const TEACHER_PRIMARY_TAB_KEYS: NavKey[] = ["dashboard", "classes", "payments", "messages"];

// ---------------------------------------------------------------------------
// Dashboard tile order (customizable "Day to day" grid)
// ---------------------------------------------------------------------------

// The keys shown in the web dashboard's "Day to day" card / the mobile
// equivalent, in the historical default order. Both platforms render this
// same set so a teacher's saved order/visibility applies identically on
// either app.
export const DEFAULT_DASHBOARD_TILE_KEYS: NavKey[] = [
  "getStudents",
  "classes",
  "students",
  "payments",
  "leads",
  "testimonials",
  "discounts",
  "referrals",
  "shareGroups",
  "materials",
  "availability",
  "blockedDates",
  "account",
  "help",
];

export type DashboardTilePref = { key: NavKey; hidden: boolean };

/** Merge a teacher's saved dashboard tile order with the canonical default
 * set: drop stale/unknown/duplicate keys from the saved list, then append any
 * default keys the teacher hasn't seen yet (new product surface) at the end.
 * `null`/`undefined` (never customized) resolves to the default order with
 * nothing hidden. */
export function resolveDashboardTiles(
  saved: DashboardTilePref[] | null | undefined,
): DashboardTilePref[] {
  const validKeys = new Set<NavKey>(DEFAULT_DASHBOARD_TILE_KEYS);
  const seen = new Set<NavKey>();
  const result: DashboardTilePref[] = [];
  for (const entry of saved ?? []) {
    if (!entry || !validKeys.has(entry.key) || seen.has(entry.key)) continue;
    seen.add(entry.key);
    result.push({ key: entry.key, hidden: Boolean(entry.hidden) });
  }
  for (const key of DEFAULT_DASHBOARD_TILE_KEYS) {
    if (!seen.has(key)) result.push({ key, hidden: false });
  }
  return result;
}

const NAV_BY_KEY: Record<NavKey, NavItem> = NAV_ITEMS.reduce(
  (acc, item) => {
    acc[item.key] = item;
    return acc;
  },
  {} as Record<NavKey, NavItem>,
);

/** Look up a single nav item by key. Throws on an unknown key so a typo in a
 * platform's curated list fails loudly rather than rendering a blank row. */
export function navItem(key: NavKey): NavItem {
  const item = NAV_BY_KEY[key];
  if (!item) throw new Error(`Unknown nav key: ${key}`);
  return item;
}

/** All items in a group, in declaration order. */
export function navGroup(group: NavGroupKey): NavItem[] {
  return NAV_ITEMS.filter((item) => item.group === group);
}

/** Resolve an item's label in the given locale, falling back to English. */
export function navLabel(item: NavItem, locale: NavLocale): string {
  return item.label[locale] ?? item.label.en;
}

/** Resolve an item's description in the given locale (English fallback), or
 * undefined when the item carries none. */
export function navDescription(item: NavItem, locale: NavLocale): string | undefined {
  if (!item.description) return undefined;
  return item.description[locale] ?? item.description.en;
}
