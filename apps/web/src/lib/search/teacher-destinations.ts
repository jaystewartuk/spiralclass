import {
  Bell,
  BookOpen,
  CalendarPlus,
  History,
  LayoutGrid,
  type LucideIcon,
  MailPlus,
  NotebookPen,
  PenSquare,
  Send,
  Target,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { LOCALES, NAV_ITEMS, type NavKey } from "@spiralclass/shared";
import type { AppLocale, StringKey, TFunction } from "@/lib/i18n-translate";
import { classesHref } from "@/lib/classes-list";
import { webNavLink } from "@/lib/nav";
import { navIcon } from "@/lib/nav-icons";
import type { SearchEntry } from "./match";

// The teacher's half of "search for a page": every destination in the shared
// nav registry, plus the pages and actions no menu lists.
//
// The nav half is DERIVED, not restated. A page added to
// packages/shared/src/nav.ts becomes searchable in the same change, and the
// `Record<NavKey, …>` below refuses to typecheck until it has search words.
// The second half is the list that exists because of how this feature was
// asked for: the day plan, "add a student" and "book a class" are pages a
// teacher could not find, because no menu links to them.
// tests/search/destinations.test.ts fails when a page under (app)/ is in
// neither list and not deliberately excluded.

/** A page or action, with the icon the result row draws. Built in the browser. */
export type SearchDestination = SearchEntry & {
  kind: "page" | "action";
  icon?: LucideIcon;
  /** Offered before she has typed anything. */
  suggested?: boolean;
};

// The words a teacher might type for each destination that are not its label:
// what she calls it ("packet"), what the page lets her do ("price"), and the
// other product's name for it. One catalog string per destination, so each
// locale carries its own vocabulary.
const NAV_KEYWORDS: Record<NavKey, StringKey> = {
  dashboard: "web.search.keywords.dashboard",
  calendar: "web.search.keywords.calendar",
  classes: "web.search.keywords.classes",
  students: "web.search.keywords.students",
  payments: "web.search.keywords.payments",
  messages: "web.search.keywords.messages",
  getStudents: "web.search.keywords.getStudents",
  bookingPage: "web.search.keywords.bookingPage",
  publicPage: "web.search.keywords.publicPage",
  leads: "web.search.keywords.leads",
  testimonials: "web.search.keywords.testimonials",
  discounts: "web.search.keywords.discounts",
  referrals: "web.search.keywords.referrals",
  shareGroups: "web.search.keywords.shareGroups",
  materials: "web.search.keywords.materials",
  focusTags: "web.search.keywords.focusTags",
  classContentTemplates: "web.search.keywords.classContentTemplates",
  materialStyle: "web.search.keywords.materialStyle",
  availability: "web.search.keywords.availability",
  blockedDates: "web.search.keywords.blockedDates",
  calendarSync: "web.search.keywords.calendarSync",
  packages: "web.search.keywords.packages",
  paymentMethods: "web.search.keywords.paymentMethods",
  billing: "web.search.keywords.billing",
  notifications: "web.search.keywords.notifications",
  account: "web.search.keywords.account",
  help: "web.search.keywords.help",
  privacy: "web.search.keywords.privacy",
  terms: "web.search.keywords.terms",
};

// Shown on an empty search, so the box teaches what it can find before she
// types. The pages that prompted the feature lead.
const SUGGESTED_NAV: ReadonlySet<NavKey> = new Set(["students", "packages", "availability"]);

type TeacherAction = {
  id: string;
  href: string;
  label: StringKey;
  detail: StringKey;
  keywords: StringKey;
  icon: LucideIcon;
  suggested?: boolean;
};

export const TEACHER_ACTIONS: readonly TeacherAction[] = [
  {
    id: "planDay",
    href: "/dashboard/classes/plan",
    label: "web.dashboard.classes.plan.title",
    detail: "web.search.action.planDay.detail",
    keywords: "web.search.keywords.planDay",
    icon: NotebookPen,
    suggested: true,
  },
  {
    id: "addStudent",
    href: "/dashboard/students/new",
    label: "web.dashboard.students.new.title",
    detail: "web.search.action.addStudent.detail",
    keywords: "web.search.keywords.addStudent",
    icon: UserPlus,
    suggested: true,
  },
  {
    id: "bookClass",
    href: "/dashboard/classes/book",
    label: "web.search.action.bookClass.label",
    detail: "web.search.action.bookClass.detail",
    keywords: "web.search.keywords.bookClass",
    icon: CalendarPlus,
    suggested: true,
  },
  {
    id: "pastClasses",
    href: classesHref("past"),
    label: "web.search.action.pastClasses.label",
    detail: "web.search.action.pastClasses.detail",
    keywords: "web.search.keywords.pastClasses",
    icon: History,
  },
  {
    id: "inviteStudents",
    href: "/dashboard/students/invitations/new",
    label: "web.dashboard.invitations.form.title",
    detail: "web.search.action.inviteStudents.detail",
    keywords: "web.search.keywords.inviteStudents",
    icon: Send,
  },
  {
    id: "invitations",
    href: "/dashboard/students/invitations",
    label: "web.dashboard.invitations.title",
    detail: "web.search.action.invitations.detail",
    keywords: "web.search.keywords.invitations",
    icon: MailPlus,
  },
  {
    id: "newMessage",
    href: "/dashboard/messages/new",
    label: "web.search.action.newMessage.label",
    detail: "web.search.action.newMessage.detail",
    keywords: "web.search.keywords.newMessage",
    icon: PenSquare,
  },
  {
    id: "notificationsInbox",
    href: "/notifications",
    label: "web.notifications.title",
    detail: "web.search.action.notificationsInbox.detail",
    keywords: "web.search.keywords.notificationsInbox",
    icon: Bell,
  },
  {
    id: "customizeDashboard",
    href: "/dashboard/customize",
    label: "web.search.action.customizeDashboard.label",
    detail: "home.dayToDaySubtitle",
    keywords: "web.search.keywords.customizeDashboard",
    icon: LayoutGrid,
  },
  {
    id: "acquisitionProfile",
    href: "/dashboard/get-students/profile",
    label: "web.getStudents.profileTitle",
    detail: "web.search.action.acquisitionProfile.detail",
    keywords: "web.search.keywords.acquisitionProfile",
    icon: Target,
  },
  {
    id: "acquisitionResults",
    href: "/dashboard/get-students/results",
    label: "web.search.action.acquisitionResults.label",
    detail: "web.search.action.acquisitionResults.detail",
    keywords: "web.search.keywords.acquisitionResults",
    icon: TrendingUp,
  },
];

/** Every nav destination and action, labelled in `locale`. */
export function teacherDestinations(opts: {
  locale: AppLocale;
  t: TFunction;
  bookingSlug?: string;
}): SearchDestination[] {
  const { locale, t, bookingSlug } = opts;

  const pages: SearchDestination[] = NAV_ITEMS
    // The public page needs her slug; without one there is nowhere to send her.
    .filter((item) => item.key !== "publicPage" || Boolean(bookingSlug))
    .map((item) => {
      const link = webNavLink(item.key, locale, { bookingSlug });
      // Every locale's label is searchable, not only hers: a teacher who
      // switched her screens to English still types "paquetes".
      const otherLabels = LOCALES.map((l) => item.label[l.tag]).filter(Boolean);
      return {
        id: `nav.${item.key}`,
        kind: "page",
        label: link.label,
        detail: link.description,
        href: link.href,
        external: link.external,
        terms: [t(NAV_KEYWORDS[item.key]), ...otherLabels].join(" "),
        icon: navIcon(item.key) ?? BookOpen,
        suggested: SUGGESTED_NAV.has(item.key),
      };
    });

  const actions: SearchDestination[] = TEACHER_ACTIONS.map((action) => ({
    id: `action.${action.id}`,
    kind: "action",
    label: t(action.label),
    detail: t(action.detail),
    href: action.href,
    terms: t(action.keywords),
    icon: action.icon,
    suggested: action.suggested,
  }));

  return [...pages, ...actions];
}
