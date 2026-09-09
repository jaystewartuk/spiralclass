// The "Crecer" / "Grow" checklist — the in-app teacher-amplification guide.
//
// D-24 / the student-acquisition design: SpiralClass does not run a
// marketplace; instead it makes the traffic and word-of-mouth a teacher already
// drives convert and compound. This module is the ROI-ordered playbook that ties
// the already-shipped acquisition features (profile, testimonials, the share
// surface, the leads inbox) into one guided, *stateful* sequence.
//
// It is deliberately NOT a help article (the kind that goes stale unread): every
// step is welded to a working feature, its done-state derived from real data so
// it reads as live progress, not prose that rots. Only Phase-1 (shipped) steps
// live here — referral / taster-offer steps stay out until those features exist,
// so the guide can never point at something that isn't built.
//
// Like nav.ts this owns *structure + bilingual copy* and is platform-agnostic:
// each app feeds it the booleans it computes from its own data source and renders
// the resolved steps with native components.

import { type NavKey, type NavLocale } from "./nav";

export type GrowthStepKey = "payment" | "profile" | "testimonials" | "share" | "leads";

// The real-world signals each step's done-state is derived from. Both web and
// mobile compute these from the same underlying columns (teacher.photoPath /
// teacher.bio, published testimonial count, linked-student count, new-lead count,
// stripeChargesEnabled/isWiseReady()) so the two platforms can't disagree about
// what "done" means.
export type GrowthSignals = {
  hasPhoto: boolean;
  hasBio: boolean;
  testimonialCount: number;
  hasStudents: boolean;
  newLeadCount: number;
  // Teacher onboarding/activation audit (docs/architecture/
  // the onboarding activation audit): true once a usable payout
  // rail is connected (stripeChargesEnabled || isWiseReady()). Without this,
  // every other step in this checklist is moot — a teacher can't actually get
  // paid for the students/testimonials/leads the rest of the checklist helps
  // her generate.
  hasPayoutMethod: boolean;
  // Whether Stripe is actually an option for this teacher — the same gate the
  // settings page uses (`stripeAvailable` in settings/payments/page.tsx:
  // isConnectCountrySupported(teacher.country) || already linked, and only
  // once the platform itself has Stripe creds configured). false swaps the
  // payment step's "todo" copy to a Wise-only variant so a teacher outside
  // the Stripe Connect circle (D-58) isn't told to "Connect Stripe" only to
  // hit the country-unsupported wall on the settings page. Optional so a
  // stale cached mobile payload (or a fixture that predates this field)
  // degrades to the pre-existing Stripe+Wise copy rather than guessing wrong.
  stripeAvailable?: boolean;
};

// The channels the "share" step can push a teacher's booking link through.
// WhatsApp is the default broadcast channel; Facebook covers the community
// *groups* that found Alicia Moreno her first students (STUDENT_ACQUISITION.md).
// Posting to a group itself stays human-driven — Meta removed the Groups
// publishing API in 2024, and automated posts get a member banned — so the app
// *assists* (ready-to-paste, attribution-tagged) rather than auto-posts.
export type ShareChannel = "whatsapp" | "facebook";

// What a step's CTA does. Most steps navigate to the feature that executes them;
// "share" is the one inherent *action* — it hands the teacher a prefilled post
// for each channel, which each platform wires to its own share affordance.
export type GrowthAction =
  { kind: "nav"; nav: NavKey } | { kind: "share"; channels: ShareChannel[] };

export type ResolvedGrowthStep = {
  key: GrowthStepKey;
  done: boolean;
  title: string;
  body: string;
  ctaLabel: string;
  action: GrowthAction;
  // A count worth surfacing as a badge next to the step (today: unanswered
  // leads). Present only when > 0 and meaningful for the step.
  count?: number;
};

export type GrowthChecklist = {
  steps: ResolvedGrowthStep[];
  doneCount: number;
  total: number;
  // True once every step is done — lets a surface collapse or celebrate instead
  // of nagging a teacher who's already doing everything.
  complete: boolean;
  // Rounded 0-100 completion percentage (doneCount/total). Onboarding-audit
  // From the same audit: a single visible number is the "reward before the ask" signal
  // marketplace onboarding (Airbnb/Shopify-style launch checklists) uses to
  // pull a teacher back to finish, rather than a bare item list.
  percent: number;
};

type Copy = Record<NavLocale, string>;

function pick(copy: Copy, locale: NavLocale): string {
  return copy[locale];
}

function interpolate(template: string, n: number): string {
  return template.replace("{n}", String(n));
}

// es-MX is the default locale; copy is written Spanish-first. Bodies carry a
// one-line piece of marketing judgement (the "why"), not just an instruction —
// that framing is the durable value the button alone doesn't give.
const HEADER: { title: Copy; subtitle: Copy; progress: Copy; allDone: Copy } = {
  title: { "es-MX": "Crecer", en: "Grow", fr: "Développer" },
  subtitle: {
    "es-MX": "Pasos para llenar tu agenda.",
    en: "Steps to fill your schedule.",
    fr: "Des étapes pour remplir votre agenda.",
  },
  progress: {
    "es-MX": "{n} de {total} listos",
    en: "{n} of {total} done",
    fr: "{n} sur {total} terminés",
  },
  allDone: {
    "es-MX": "¡Listo! Estás haciendo todo para crecer.",
    en: "All set — you're doing everything to grow.",
    fr: "C'est parfait — vous faites tout pour vous développer.",
  },
};

const STEPS: Record<
  GrowthStepKey,
  {
    title: Copy;
    todo: Copy;
    // Wise-only variant of `todo`, used instead when GrowthSignals.
    // stripeAvailable is explicitly false. Only "payment" defines this.
    todoWiseOnly?: Copy;
    done: Copy;
    cta: Copy;
    action: GrowthAction;
  }
> = {
  payment: {
    title: {
      "es-MX": "Recibe tus pagos",
      en: "Get set up to get paid",
      fr: "Configurez votre paiement",
    },
    todo: {
      "es-MX": "Conecta Stripe o Wise. Sin esto, no puedes cobrar tus clases.",
      en: "Connect Stripe or Wise. Without this you can't get paid for your classes.",
      fr: "Connectez Stripe ou Wise. Sans cela, vous ne pouvez pas être payé pour vos cours.",
    },
    todoWiseOnly: {
      "es-MX": "Conecta Wise. Sin esto, no puedes cobrar tus clases.",
      en: "Connect Wise. Without this you can't get paid for your classes.",
      fr: "Connectez Wise. Sans cela, vous ne pouvez pas être payé pour vos cours.",
    },
    done: {
      "es-MX": "Ya puedes recibir pagos por tus clases.",
      en: "You're set up to get paid for your classes.",
      fr: "Vous êtes prêt à être payé pour vos cours.",
    },
    cta: { "es-MX": "Configurar pagos", en: "Set up payments", fr: "Configurer les paiements" },
    action: { kind: "nav", nav: "paymentMethods" },
  },
  profile: {
    title: {
      "es-MX": "Completa tu perfil",
      en: "Complete your profile",
      fr: "Complétez votre profil",
    },
    todo: {
      "es-MX": "Agrega tu foto y una bio breve. Los alumnos reservan con quien pueden ver.",
      en: "Add your photo and a short bio. Students book with a teacher they can see.",
      fr: "Ajoutez votre photo et une courte bio. Les élèves réservent avec un professeur qu'ils peuvent voir.",
    },
    done: {
      "es-MX": "Tu foto y tu bio ya están en tu página.",
      en: "Your photo and bio are live on your page.",
      fr: "Votre photo et votre bio sont en ligne sur votre page.",
    },
    cta: { "es-MX": "Editar perfil", en: "Edit profile", fr: "Modifier le profil" },
    // Photo/bio are edited on the booking-page settings screen, not the
    // account screen (account is name/email/phone/timezone — see the comment
    // on apps/web/src/app/(app)/settings/account/page.tsx). Was "account"
    // before this fix, a real dead-end on both platforms.
    action: { kind: "nav", nav: "bookingPage" },
  },
  testimonials: {
    title: { "es-MX": "Suma una reseña", en: "Add a testimonial", fr: "Ajoutez un témoignage" },
    todo: {
      "es-MX": "Pide a un alumno una frase y publícala. La prueba social convierte.",
      en: "Ask a student for a line and publish it. Social proof converts.",
      fr: "Demandez une phrase à un élève et publiez-la. La preuve sociale fait la différence.",
    },
    // {n} interpolated; plural handled per-locale in resolve().
    done: {
      "es-MX": "Tienes {n} reseña{s} publicada{s} en tu página.",
      en: "You have {n} testimonial{s} live on your page.",
      fr: "Vous avez {n} témoignage{s} en ligne sur votre page.",
    },
    cta: { "es-MX": "Agregar reseña", en: "Add testimonial", fr: "Ajouter un témoignage" },
    action: { kind: "nav", nav: "testimonials" },
  },
  share: {
    title: { "es-MX": "Comparte tu enlace", en: "Share your link", fr: "Partagez votre lien" },
    todo: {
      "es-MX": "Compártelo donde ya estás: WhatsApp y grupos de Facebook. Así te encuentran.",
      en: "Share it where you already are: WhatsApp and Facebook groups. That's how they find you.",
      fr: "Partagez-le là où vous êtes déjà : WhatsApp et les groupes Facebook. C'est ainsi qu'on vous trouve.",
    },
    done: {
      "es-MX": "Ya tienes alumnos que llegaron por tu enlace. Sigue compartiéndolo.",
      en: "You've got students who came through your link. Keep sharing it.",
      fr: "Vous avez déjà des élèves arrivés par votre lien. Continuez à le partager.",
    },
    // Per-channel CTA labels live in SHARE below; this generic label keeps the
    // ResolvedGrowthStep.ctaLabel invariant non-empty for the share step.
    cta: { "es-MX": "Comparte tu enlace", en: "Share your link", fr: "Partagez votre lien" },
    action: { kind: "share", channels: ["whatsapp", "facebook"] },
  },
  leads: {
    title: {
      "es-MX": "Atiende a los interesados",
      en: "Follow up with leads",
      fr: "Relancez les personnes intéressées",
    },
    // todo only shows when there's something pending (count > 0).
    todo: {
      "es-MX": "Tienes {n} mensaje{s} sin responder. Responde rápido: la velocidad convierte.",
      en: "You have {n} unanswered message{s}. Reply fast — speed converts.",
      fr: "Vous avez {n} message{s} sans réponse. Répondez vite — la rapidité fait la différence.",
    },
    done: {
      "es-MX": "No tienes mensajes pendientes.",
      en: "No pending messages.",
      fr: "Vous n'avez aucun message en attente.",
    },
    cta: { "es-MX": "Ver interesados", en: "View leads", fr: "Voir les intéressés" },
    action: { kind: "nav", nav: "leads" },
  },
};

// Render "{s}" plural markers: drop for n === 1, keep the letter otherwise.
// Handles both the es-MX "reseña{s}" and en "testimonial{s}" forms.
function applyPlural(text: string, n: number): string {
  return text.replace(/\{s\}/g, n === 1 ? "" : "s");
}

// "payment" leads the order: every other step helps a teacher generate demand
// she structurally cannot get paid for until a payout rail is connected.
const ORDER: GrowthStepKey[] = ["payment", "profile", "testimonials", "share", "leads"];

function isDone(key: GrowthStepKey, s: GrowthSignals): boolean {
  switch (key) {
    case "payment":
      return s.hasPayoutMethod;
    case "profile":
      return s.hasPhoto && s.hasBio;
    case "testimonials":
      return s.testimonialCount >= 1;
    case "share":
      // The link producing at least one student is the proof distribution works;
      // the step stays useful (keep sharing) even once done.
      return s.hasStudents;
    case "leads":
      // "Inbox zero" — nothing awaiting a reply. A brand-new teacher with no
      // leads is trivially done here, which is correct: nothing needs attention.
      return s.newLeadCount === 0;
  }
}

/**
 * Resolve the ordered, ROI-sorted growth checklist for a teacher in `locale`.
 * Pure: feed it the signals, render the result. The same call drives the web
 * dashboard card and the mobile "Crecer" card.
 */
export function growthSteps(signals: GrowthSignals, locale: NavLocale): GrowthChecklist {
  const steps: ResolvedGrowthStep[] = ORDER.map((key) => {
    const def = STEPS[key];
    const done = isDone(key, signals);

    let body: string;
    let count: number | undefined;
    if (key === "testimonials" && done) {
      body = applyPlural(
        interpolate(pick(def.done, locale), signals.testimonialCount),
        signals.testimonialCount,
      );
    } else if (key === "leads") {
      count = signals.newLeadCount > 0 ? signals.newLeadCount : undefined;
      body = done
        ? pick(def.done, locale)
        : applyPlural(
            interpolate(pick(def.todo, locale), signals.newLeadCount),
            signals.newLeadCount,
          );
    } else if (
      key === "payment" &&
      !done &&
      signals.stripeAvailable === false &&
      def.todoWiseOnly
    ) {
      // Country-gated, same as the settings page: don't tell a teacher outside
      // the Stripe Connect circle to "Connect Stripe" only to hit the
      // country-unsupported wall when she follows the CTA.
      body = pick(def.todoWiseOnly, locale);
    } else {
      body = applyPlural(pick(done ? def.done : def.todo, locale), 0);
    }

    return {
      key,
      done,
      title: pick(def.title, locale),
      body,
      ctaLabel: pick(def.cta, locale),
      action: def.action,
      ...(count ? { count } : {}),
    };
  });

  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;
  return {
    steps,
    doneCount,
    total,
    complete: doneCount === total,
    percent: Math.round((doneCount / total) * 100),
  };
}

/** Card title ("Crecer" / "Grow"). */
export function growthTitle(locale: NavLocale): string {
  return pick(HEADER.title, locale);
}

/** Card subtitle. */
export function growthSubtitle(locale: NavLocale): string {
  return pick(HEADER.subtitle, locale);
}

/** "{n} of {total} done" progress label. */
export function growthProgressLabel(doneCount: number, total: number, locale: NavLocale): string {
  return pick(HEADER.progress, locale)
    .replace("{n}", String(doneCount))
    .replace("{total}", String(total));
}

/** Celebratory line shown when every step is done. */
export function growthAllDoneLabel(locale: NavLocale): string {
  return pick(HEADER.allDone, locale);
}

// ── Share channels ─────────────────────────────────────────────────────────
// The "share" step's per-channel copy + attribution, owned here so web and
// mobile build identical posts and tag links the same way. A platform renders
// one CTA per `action.channels` entry and feeds the share affordance the text
// from `shareText()` (which already embeds the tagged URL).

// Per-channel CTA labels.
const SHARE_LABEL: Record<ShareChannel, Copy> = {
  whatsapp: {
    "es-MX": "Compartir por WhatsApp",
    en: "Share on WhatsApp",
    fr: "Partager sur WhatsApp",
  },
  facebook: {
    "es-MX": "Compartir en Facebook",
    en: "Share on Facebook",
    fr: "Partager sur Facebook",
  },
};

// Per-channel post body. {url} is replaced with the attribution-tagged link.
// WhatsApp stays the existing terse one-liner (1:1 / contact lists); Facebook
// gets a fuller, group-appropriate post a teacher can paste and lightly edit —
// it reads as a person offering classes, not an ad, which is what survives in
// community groups.
const SHARE_TEXT: Record<ShareChannel, Copy> = {
  whatsapp: {
    "es-MX": "¡Hola! Reserva y paga tus clases conmigo aquí: {url}",
    en: "Hi! Book and pay for your classes with me here: {url}",
    fr: "Bonjour ! Réservez et payez vos cours avec moi ici : {url}",
  },
  facebook: {
    "es-MX":
      "Doy clases particulares y tengo cupo disponible. Puedes ver mis paquetes, horarios y reservar directo aquí 👇\n\n{url}\n\n¿Dudas? Escríbeme con gusto.",
    en: "I give private lessons and have spots open. See my packages, schedule and book directly here 👇\n\n{url}\n\nQuestions? Happy to help — just message me.",
    fr: "Je donne des cours particuliers et j'ai des places disponibles. Découvrez mes forfaits, mes horaires et réservez directement ici 👇\n\n{url}\n\nDes questions ? Écrivez-moi avec plaisir.",
  },
};

// UTM tags so PostHog attributes a student who arrives from a shared link to
// the channel the teacher posted in — closing the loop (which group/channel
// converts) with zero backend change. Distinct from the ?ref= ambassador
// cookie, which attributes *teacher* signups, so these never collide.
const SHARE_UTM: Record<ShareChannel, { source: string; medium: string }> = {
  whatsapp: { source: "whatsapp", medium: "share" },
  facebook: { source: "facebook", medium: "group" },
};

/** The booking URL with this channel's attribution UTM params appended. */
/** A saved TeacherShareGroup, reduced to what tagging needs. */
export type ShareGroupRef = { id: string; name: string };

// Keeps the readable half of the tag short enough that the whole value stays
// well inside the 96-char cap the server-side attribution parser applies.
const GROUP_SLUG_MAX = 32;

/**
 * Stable `utm_content` value for one saved Facebook group.
 *
 * This is the ONLY thing that can tell two groups apart in analytics.
 * Facebook's referrer is just `l.facebook.com` — it never names the group —
 * and `fbclid` is per-click, so an untagged post is attributable to "Facebook"
 * and no further. Tagging by hand works but is exactly the step that gets
 * skipped or mistyped, and a typo doesn't fail loudly: it silently splits one
 * group into two rows in the breakdown.
 *
 * Readable-first (`expats-cdmx-a1b2`, not a raw UUID) because these values are
 * read directly off a PostHog breakdown; the 4-char id suffix is what keeps
 * two groups with the same — or same-after-slugifying — name from silently
 * merging into one channel.
 *
 * Charset is deliberately `[a-z0-9-]`: the server strips anything outside
 * `[a-z0-9._-+ ]` when it reads the value back
 * (apps/web/src/lib/analytics/attribution.ts), so anything else would arrive
 * mangled and mismatch what the teacher shared.
 */
export function shareGroupSlug(group: ShareGroupRef): string {
  const base = group.name
    // Strip accents first so "Español" tags as "espanol" rather than losing
    // the letter entirely — Spanish group names are the common case.
    .normalize("NFD")
    // \u0300-\u036f = the combining diacritical marks NFD splits off. Written
    // escaped, not as literal combining characters, which are invisible in a
    // diff and easy for an editor to normalise away.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, GROUP_SLUG_MAX)
    .replace(/-+$/g, "");
  const suffix = group.id.replace(/-/g, "").slice(0, 4).toLowerCase();
  // A name of only emoji/CJK slugifies to nothing — still needs a usable tag.
  return base ? `${base}-${suffix}` : `group-${suffix}`;
}

/**
 * The booking URL tagged for a channel, and optionally for the specific group
 * being posted in. Without `group` the link is attributable to the channel
 * only — which is all a generic "share on Facebook" button can honestly claim.
 */
export function shareTaggedUrl(
  bookingUrl: string,
  channel: ShareChannel,
  group?: ShareGroupRef,
): string {
  const { source, medium } = SHARE_UTM[channel];
  const sep = bookingUrl.includes("?") ? "&" : "?";
  const content = group ? `&utm_content=${encodeURIComponent(shareGroupSlug(group))}` : "";
  return `${bookingUrl}${sep}utm_source=${source}&utm_medium=${medium}&utm_campaign=teacher_share${content}`;
}

/** Ready-to-share post for `channel`, with the attribution-tagged link embedded. */
export function shareText(
  bookingUrl: string,
  channel: ShareChannel,
  locale: NavLocale,
  group?: ShareGroupRef,
): string {
  return pick(SHARE_TEXT[channel], locale).replace(
    "{url}",
    shareTaggedUrl(bookingUrl, channel, group),
  );
}

/** The CTA label for a share channel ("Share on WhatsApp" / "Share on Facebook"). */
export function shareChannelLabel(channel: ShareChannel, locale: NavLocale): string {
  return pick(SHARE_LABEL[channel], locale);
}

/**
 * The stable half of a `shareGroupSlug` — the 4-hex id suffix.
 *
 * This is the INVERSE side of shareGroupSlug, and it exists because the
 * readable half is NOT stable: renaming a group changes its slug, but links
 * carrying the old slug are already posted in that group and will keep being
 * crawled for as long as the post lives. Matching on the id suffix means a
 * rename never orphans an already-shared link from the social preview attached
 * to it (D-123).
 *
 * Returns null when the value isn't a slug we minted, so a hand-typed or
 * third-party `utm_content` resolves to "no group" rather than to an arbitrary
 * one.
 */
export function shareGroupSlugSuffix(utmContent: string | null | undefined): string | null {
  if (!utmContent) return null;
  const last = utmContent.trim().toLowerCase().split("-").pop() ?? "";
  return /^[0-9a-f]{4}$/.test(last) ? last : null;
}

/**
 * Resolve a `utm_content` value back to one of a teacher's saved groups.
 *
 * Exact slug match wins (it pins both halves, so it disambiguates the
 * vanishingly rare case of two groups sharing an id prefix); the id-suffix
 * match is the rename-tolerant fallback. Scoped to one teacher's groups by the
 * caller, so a 4-hex space is ample.
 */
export function matchShareGroupBySlug<T extends ShareGroupRef>(
  groups: readonly T[],
  utmContent: string | null | undefined,
): T | null {
  if (!utmContent) return null;
  const value = utmContent.trim().toLowerCase();
  const exact = groups.find((g) => shareGroupSlug(g) === value);
  if (exact) return exact;

  const suffix = shareGroupSlugSuffix(value);
  if (!suffix) return null;
  const matches = groups.filter((g) => g.id.replace(/-/g, "").slice(0, 4).toLowerCase() === suffix);
  // Ambiguous prefix within one teacher's groups: refuse rather than guess —
  // showing the wrong group's meme is worse than showing the default card.
  return matches.length === 1 ? matches[0] : null;
}
