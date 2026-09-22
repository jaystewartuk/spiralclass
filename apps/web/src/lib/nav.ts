import {
  type NavGroupKey,
  type NavKey,
  type NavLocale,
  navDescription,
  navGroup,
  navItem,
  navLabel,
  TEACHER_PRIMARY_TAB_KEYS,
} from "@spiralclass/shared";

// Web-side resolver for the shared IA (packages/shared/src/nav.ts). The shared
// model owns structure + labels; this file owns the one thing that's genuinely
// web-specific — the route each destination lives at — plus the active-state
// matching the header/menus need. Keep this the ONLY place web maps a NavKey to
// a path, so the bar, the account menu, and the dashboard grid can't disagree
// about where "Leads" points.

type RouteDef = { href: string; match?: string; exact?: boolean };

// publicPage is intentionally absent — it needs the teacher's booking slug and
// is resolved through `webNavHref` with `bookingSlug`.
const ROUTES: Record<Exclude<NavKey, "publicPage">, RouteDef> = {
  dashboard: { href: "/dashboard", match: "/dashboard", exact: true },
  calendar: { href: "/dashboard/calendar" },
  classes: { href: "/dashboard/classes" },
  students: { href: "/dashboard/students" },
  payments: { href: "/payments" },
  messages: { href: "/dashboard/messages" },
  leads: { href: "/dashboard/leads" },
  testimonials: { href: "/dashboard/testimonials" },
  discounts: { href: "/dashboard/discounts" },
  referrals: { href: "/dashboard/referrals" },
  getStudents: { href: "/dashboard/get-students" },
  shareGroups: { href: "/dashboard/get-students/communities" },
  availability: { href: "/settings/availability" },
  blockedDates: { href: "/settings/blocked-dates" },
  calendarSync: { href: "/settings/calendar" },
  packages: { href: "/settings/templates" },
  materials: { href: "/dashboard/materials" },
  focusTags: { href: "/settings/focus-tags" },
  classContentTemplates: { href: "/settings/class-content-templates" },
  materialStyle: { href: "/settings/materials" },
  paymentMethods: { href: "/settings/payments" },
  billing: { href: "/settings/billing" },
  notifications: { href: "/settings/notifications" },
  account: { href: "/settings/account" },
  bookingPage: { href: "/settings/booking-page" },
  help: { href: "/help" },
  privacy: { href: "/privacy-notice" },
  terms: { href: "/terms" },
};

export type WebNavLink = {
  key: NavKey;
  href: string;
  label: string;
  description?: string;
  match: string;
  exact: boolean;
  external: boolean;
};

/** The web path for a destination. `publicPage` requires `bookingSlug`. */
export function webNavHref(key: NavKey, opts?: { bookingSlug?: string }): string {
  if (key === "publicPage") {
    const slug = opts?.bookingSlug ?? "";
    return slug ? `/b/${slug}` : "#";
  }
  return ROUTES[key].href;
}

/** A fully-resolved link (label + description in `locale`, href, active-match
 * metadata) for rendering in any web nav surface. */
export function webNavLink(
  key: NavKey,
  locale: NavLocale,
  opts?: { bookingSlug?: string },
): WebNavLink {
  const item = navItem(key);
  const href = webNavHref(key, opts);
  const route = key === "publicPage" ? undefined : ROUTES[key];
  return {
    key,
    href,
    label: navLabel(item, locale),
    description: navDescription(item, locale),
    match: route?.match ?? href,
    exact: route?.exact ?? false,
    external: item.external ?? false,
  };
}

/** Every link in a group, resolved for `locale`. */
export function webNavGroup(
  group: NavGroupKey,
  locale: NavLocale,
  opts?: { bookingSlug?: string },
): WebNavLink[] {
  return navGroup(group).map((item) => webNavLink(item.key, locale, opts));
}

/** The primary task destinations for the mobile-web bottom tab bar, resolved
 * for `locale` from the shared canonical set (Panel / Clases / Pagos / Mensajes).
 * The bar composes these with the notification inbox and a Settings entry, which
 * carry no single main-group NavKey and are added by the component. */
export function webTabBarLinks(locale: NavLocale, opts?: { bookingSlug?: string }): WebNavLink[] {
  return TEACHER_PRIMARY_TAB_KEYS.map((key) => webNavLink(key, locale, opts));
}

/** Resolve a curated, ordered subset of keys (e.g. the dashboard grid). */
export function webNavLinks(
  keys: NavKey[],
  locale: NavLocale,
  opts?: { bookingSlug?: string },
): WebNavLink[] {
  return keys.map((key) => webNavLink(key, locale, opts));
}

// Config-group destinations that have no nav link anywhere else on web
// (unlike availability/bookingPage, which are reachable from contextual links
// on their own pages) — the account menu is their only way in, on both desktop
// and the mobile-web menu panel.
//
// `billing` USED TO BE excluded on that same "reachable contextually" grounds,
// and it was the one key for which the reasoning did not hold. Every contextual
// link to it is an UPSELL — the trial and past-due banner, the Pro lock note,
// the call and replay CTAs — so all four disappear the moment a teacher starts
// paying. Once she was on Pro and healthy, her own billing page was reachable
// only from an old receipt email or by typing the URL: no menu, no dashboard
// tile, and there is no /settings index to browse. The person who gives us
// money had the worst access to the page about it.
//
// It sits beside `paymentMethods` deliberately. That one is how her students
// pay HER; this one is what she pays US. Finding one and not the other was the
// asymmetry that made the gap easy to miss.
const ACCOUNT_MENU_KEYS: NavKey[] = [
  "account",
  "packages",
  "paymentMethods",
  "billing",
  "notifications",
  "calendarSync",
  "blockedDates",
  "help",
];

/** The header's account-menu links (desktop dropdown + mobile-web menu panel). */
export function webAccountMenuLinks(locale: NavLocale): WebNavLink[] {
  return webNavLinks(ACCOUNT_MENU_KEYS, locale);
}

/** Active-state test for a resolved link against the current pathname. External
 * links never report active (they leave the app). */
export function isWebNavActive(link: WebNavLink, pathname: string): boolean {
  if (link.external) return false;
  return link.exact ? pathname === link.match : pathname.startsWith(link.match);
}
