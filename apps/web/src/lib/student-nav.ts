import {
  BookOpen,
  CalendarDays,
  Library,
  type LucideIcon,
  MessageSquare,
  TrendingUp,
  UserCog,
  Users,
} from "lucide-react";
import type { AppLocale } from "@spiralclass/shared";

// The student portal's information architecture, in the shape `lib/nav.ts`
// gives the teacher's: one list that owns which destinations exist, how they
// group, what they're called, where they point, and which icon stands for
// them — so the header bar, the mobile drawer and the account menu can't
// disagree about any of it.
//
// It lives here rather than in `packages/shared/src/nav.ts` (which owns the
// TEACHER IA) on purpose: promoting it would merge two separate information
// architectures into one module no consumer wants whole.
//
// Icons are drawn from the same lucide set as `lib/nav-icons.ts`, and where a
// destination exists for both roles (calendar, materials, messages, account)
// it deliberately reuses the teacher's icon — a shared vocabulary is worth
// more than per-role novelty.

export type StudentNavKey =
  "classes" | "calendar" | "materials" | "progress" | "messages" | "teachers" | "account";

export type StudentNavItem = {
  key: StudentNavKey;
  href: string;
  label: Record<AppLocale, string>;
  icon: LucideIcon;
  /**
   * A distinct href for nav LINKS, when the destination wants to know it was
   * reached from the nav. Kept off `href` so active-state matching stays a
   * plain pathname comparison.
   */
  linkHref?: string;
};

/**
 * Order is deliberate and unchanged from the portal's first version: it is
 * what a returning student's muscle memory is already tuned to, and no
 * evidence says a different order reads better.
 */
export const STUDENT_NAV_ITEMS: StudentNavItem[] = [
  {
    key: "classes",
    href: "/my-classes",
    label: { "es-MX": "Clases", en: "Classes", fr: "Cours" },
    icon: BookOpen,
  },
  {
    key: "calendar",
    href: "/my-classes/calendar",
    // Feeds calendar_viewed's entry_point property (calendar/page.tsx).
    linkHref: "/my-classes/calendar?ref=nav",
    label: { "es-MX": "Calendario", en: "Calendar", fr: "Calendrier" },
    icon: CalendarDays,
  },
  {
    key: "materials",
    href: "/my-classes/materials",
    label: { "es-MX": "Materiales", en: "Materials", fr: "Supports" },
    icon: Library,
  },
  {
    key: "progress",
    href: "/my-classes/progress",
    label: { "es-MX": "Progreso", en: "Progress", fr: "Progrès" },
    icon: TrendingUp,
  },
  {
    key: "messages",
    href: "/my-classes/messages",
    label: { "es-MX": "Mensajes", en: "Messages", fr: "Messages" },
    icon: MessageSquare,
  },
  {
    key: "teachers",
    href: "/my-classes/teachers",
    label: { "es-MX": "Profesores", en: "Teachers", fr: "Professeurs" },
    icon: Users,
  },
  {
    key: "account",
    href: "/my-classes/account",
    label: { "es-MX": "Cuenta", en: "Account", fr: "Compte" },
    icon: UserCog,
  },
];

/** The day-to-day destinations shown inline in the desktop header bar. */
export const STUDENT_PRIMARY_KEYS: StudentNavKey[] = [
  "classes",
  "calendar",
  "materials",
  "progress",
  "messages",
  "teachers",
];

/** The destinations that live behind the desktop avatar menu. */
export const STUDENT_ACCOUNT_KEYS: StudentNavKey[] = ["account"];

export const STUDENT_ACCOUNT_HREF = "/my-classes/account";

export type StudentNavLink = {
  key: StudentNavKey;
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
};

function itemFor(key: StudentNavKey): StudentNavItem {
  const item = STUDENT_NAV_ITEMS.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Unknown student nav key: ${key}`);
  return item;
}

/**
 * "Clases" owns every /my-classes path that isn't one of the other
 * destinations — the booking detail, reservar and reagendar screens all belong
 * to the classes flow, and leaving them unmatched lit nothing in the nav.
 */
export function isStudentNavActive(item: StudentNavItem, pathname: string): boolean {
  if (item.key === "classes") {
    return !STUDENT_NAV_ITEMS.some(
      (other) => other.key !== "classes" && pathname.startsWith(other.href),
    );
  }
  return pathname.startsWith(item.href);
}

/** Resolve a set of destinations for rendering: label in `locale`, link href,
 * icon and active state, in the order given. */
export function studentNavLinks(
  keys: StudentNavKey[],
  locale: AppLocale,
  pathname: string,
): StudentNavLink[] {
  return keys.map((key) => {
    const item = itemFor(key);
    return {
      key: item.key,
      href: item.linkHref ?? item.href,
      label: item.label[locale],
      icon: item.icon,
      active: isStudentNavActive(item, pathname),
    };
  });
}
