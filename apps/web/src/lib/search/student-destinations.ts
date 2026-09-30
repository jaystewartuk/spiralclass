import { CalendarPlus, HelpCircle, type LucideIcon, PenSquare, ShoppingBag } from "lucide-react";
import { LOCALES } from "@spiralclass/shared";
import type { AppLocale, StringKey, TFunction } from "@/lib/i18n-translate";
import { STUDENT_NAV_ITEMS, type StudentNavKey } from "@/lib/student-nav";
import type { SearchDestination } from "./teacher-destinations";

// The student portal's half of "search for a page" — the same shape as
// ./teacher-destinations.ts, derived from lib/student-nav.ts so a portal page
// added to the nav is searchable in the same change.

const NAV_KEYWORDS: Record<StudentNavKey, StringKey> = {
  classes: "web.search.keywords.student.classes",
  calendar: "web.search.keywords.student.calendar",
  materials: "web.search.keywords.student.materials",
  progress: "web.search.keywords.student.progress",
  messages: "web.search.keywords.student.messages",
  teachers: "web.search.keywords.student.teachers",
  account: "web.search.keywords.student.account",
};

type StudentAction = {
  id: string;
  href: string;
  label: StringKey;
  detail: StringKey;
  keywords: StringKey;
  icon: LucideIcon;
};

export const STUDENT_ACTIONS: readonly StudentAction[] = [
  {
    id: "book",
    href: "/my-classes/book",
    label: "book.title",
    detail: "web.search.action.student.book.detail",
    keywords: "web.search.keywords.student.book",
    icon: CalendarPlus,
  },
  {
    id: "buy",
    href: "/my-classes/buy",
    label: "buyAnother.title",
    detail: "web.search.action.student.buy.detail",
    keywords: "web.search.keywords.student.buy",
    icon: ShoppingBag,
  },
  {
    id: "newMessage",
    href: "/my-classes/messages/new",
    label: "web.search.action.newMessage.label",
    detail: "web.search.action.student.newMessage.detail",
    keywords: "web.search.keywords.newMessage",
    icon: PenSquare,
  },
  {
    id: "help",
    href: "/help/student",
    label: "web.help.title",
    detail: "web.search.action.student.help.detail",
    keywords: "web.search.keywords.help",
    icon: HelpCircle,
  },
];

// A student's portal is short enough that every destination is a suggestion,
// but the empty state should still read as a shortlist.
const SUGGESTED: ReadonlySet<string> = new Set(["nav.classes", "action.book", "nav.messages"]);

export function studentDestinations(opts: {
  locale: AppLocale;
  t: TFunction;
}): SearchDestination[] {
  const { locale, t } = opts;

  const pages: SearchDestination[] = STUDENT_NAV_ITEMS.map((item) => ({
    id: `nav.${item.key}`,
    kind: "page",
    label: item.label[locale],
    href: item.href,
    terms: [t(NAV_KEYWORDS[item.key]), ...LOCALES.map((l) => item.label[l.tag])].join(" "),
    icon: item.icon,
  }));

  const actions: SearchDestination[] = STUDENT_ACTIONS.map((action) => ({
    id: `action.${action.id}`,
    kind: "action",
    label: t(action.label),
    detail: t(action.detail),
    href: action.href,
    terms: t(action.keywords),
    icon: action.icon,
  }));

  return [...pages, ...actions].map((d) => ({ ...d, suggested: SUGGESTED.has(d.id) }));
}
