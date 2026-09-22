import {
  Bell,
  BookOpen,
  CalendarDays,
  CalendarX,
  Clock,
  CreditCard,
  ExternalLink,
  FileEdit,
  FileText,
  Gift,
  HelpCircle,
  Inbox,
  LayoutDashboard,
  Library,
  type LucideIcon,
  MessageSquare,
  Package,
  Receipt,
  RefreshCw,
  ScrollText,
  Share2,
  Shield,
  Sparkles,
  Star,
  Tag,
  Tags,
  TrendingUp,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import type { NavKey } from "@spiralclass/shared";

// One icon per web nav destination, so the mobile drawer and the tablet
// sidebar (app-nav.tsx) can render icon + label rows instead of bare text —
// the icon column is what makes a long list scannable at a glance. Kept web-
// side (not in packages/shared/src/nav.ts) because the shared IA module is
// plain data with no UI-framework dependency; only web renders nav items with
// icons today.
export const NAV_ICONS: Partial<Record<NavKey, LucideIcon>> = {
  dashboard: LayoutDashboard,
  calendar: CalendarDays,
  classes: BookOpen,
  students: Users,
  payments: CreditCard,
  messages: MessageSquare,
  getStudents: TrendingUp,
  bookingPage: FileEdit,
  publicPage: ExternalLink,
  leads: Inbox,
  testimonials: Star,
  discounts: Tag,
  referrals: Gift,
  shareGroups: Share2,
  materials: Library,
  focusTags: Tags,
  classContentTemplates: FileText,
  materialStyle: Sparkles,
  availability: Clock,
  blockedDates: CalendarX,
  calendarSync: RefreshCw,
  packages: Package,
  paymentMethods: Wallet,
  billing: Receipt,
  notifications: Bell,
  account: UserCog,
  help: HelpCircle,
  privacy: Shield,
  terms: ScrollText,
};

/** The icon for a nav destination, or undefined for the handful of legal/
 * external links that don't carry one. */
export function navIcon(key: NavKey): LucideIcon | undefined {
  return NAV_ICONS[key];
}
