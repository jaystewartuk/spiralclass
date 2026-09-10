import { resolveAdminActor } from "@/lib/admin";
import { canSee, type NavSection } from "@/lib/admin-nav-visibility";
import type { AdminCapability } from "@/lib/admin-capabilities";
import { PostHogIdentify } from "@/components/posthog-identify";
import { prisma } from "@/lib/prisma";
import { getT } from "@/lib/i18n";
import type { StringKey } from "@spiralclass/shared";
import { AdminSidebar } from "./admin-sidebar";
import type { AdminRole } from "@prisma/client";

type NavKeyItem = {
  href: string;
  key: StringKey;
  minRole: AdminRole;
  capability?: AdminCapability;
  section: NavSection;
};

// Grouped sidebar sections (D-6x): Overview stands alone, then People / Money
// / Operations / Admin — replacing the old flat "5 inline + 10 in a dropdown"
// bar, which was already straining at 15 destinations.
const NAV: NavKeyItem[] = [
  { href: "/admin", key: "web.admin.nav.overview", minRole: "support", section: "overview" },
  { href: "/admin/teachers", key: "web.admin.nav.teachers", minRole: "support", section: "people" },
  { href: "/admin/students", key: "web.admin.nav.students", minRole: "support", section: "people" },
  { href: "/admin/payments", key: "web.admin.nav.payments", minRole: "finance", section: "money" },
  { href: "/admin/money", key: "web.admin.nav.money", minRole: "finance", section: "money" },
  { href: "/admin/costs", key: "web.admin.nav.costs", minRole: "finance", section: "money" },
  {
    href: "/admin/economics",
    key: "web.admin.nav.economics",
    minRole: "finance",
    section: "money",
  },
  { href: "/admin/packages", key: "web.admin.nav.packages", minRole: "support", section: "money" },
  {
    href: "/admin/subscriptions",
    key: "web.admin.nav.subscriptions",
    minRole: "finance",
    section: "money",
  },
  {
    href: "/admin/disputes",
    key: "web.admin.nav.disputes",
    minRole: "finance",
    section: "operations",
  },
  {
    href: "/admin/notifications",
    key: "web.admin.nav.notifications",
    minRole: "support",
    section: "operations",
  },
  {
    href: "/admin/lesson-insights",
    key: "web.admin.nav.lessonInsights",
    minRole: "superadmin",
    section: "operations",
  },
  {
    href: "/admin/audit",
    key: "web.admin.nav.auditLog",
    minRole: "support",
    section: "operations",
  },
  {
    href: "/admin/live-calls",
    key: "web.admin.nav.liveCalls",
    minRole: "support",
    section: "operations",
  },
  {
    href: "/admin/integrations",
    key: "web.admin.nav.integrations",
    minRole: "support",
    section: "operations",
  },
  { href: "/admin/storage", key: "web.admin.nav.storage", minRole: "superadmin", section: "admin" },
  {
    href: "/admin/database",
    key: "web.admin.nav.database",
    minRole: "superadmin",
    capability: "schema:view",
    section: "admin",
  },
  {
    href: "/admin/uat",
    key: "web.admin.nav.uatTools",
    minRole: "superadmin",
    capability: "uat:run",
    section: "admin",
  },
  { href: "/admin/staff", key: "web.admin.nav.staff", minRole: "superadmin", section: "admin" },
  { href: "/help/admin", key: "web.admin.nav.help", minRole: "support", section: "admin" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Shell only — resolves the actor for the nav without the MFA check so the
  // /admin/security step-up page (which this layout also wraps) stays
  // reachable. Every page under it enforces MFA via its own requireAdmin().
  const actor = await resolveAdminActor();
  const t = await getT();

  const ROLE_BADGE: Record<AdminRole, { label: string; variant: "warning" | "success" | "info" }> =
    {
      superadmin: { label: t("web.admin.role.superadmin"), variant: "warning" },
      finance: { label: t("web.admin.role.finance"), variant: "success" },
      support: { label: t("web.admin.role.support"), variant: "info" },
      tester: { label: t("web.admin.role.tester"), variant: "info" },
      engineer: { label: t("web.admin.role.engineer"), variant: "info" },
    };
  const badge = ROLE_BADGE[actor.role];

  // Cheap, non-sensitive health counts (no PII) surfaced as nav badges so a
  // needs-response dispute or a failed notification is visible from every
  // admin page, not just its own. Fine to compute pre-MFA, same as the role
  // badge above — the layout intentionally isn't MFA-gated (see comment
  // below); each page still enforces its own requireAdmin() for real data.
  const [needsResponseDisputes, failedNotifications] = await Promise.all([
    prisma.dispute.count({ where: { isFinal: false, status: "needs_response" } }),
    prisma.notification.count({ where: { status: "failed" } }),
  ]);

  const SECTION_LABEL_KEYS: Record<NavSection, StringKey> = {
    overview: "web.admin.nav.section.overview",
    people: "web.admin.nav.section.people",
    money: "web.admin.nav.section.money",
    operations: "web.admin.nav.section.operations",
    admin: "web.admin.nav.section.admin",
  };

  const items = NAV.filter((n) => canSee(actor, { ...n, label: n.key })).map((n) => ({
    href: n.href,
    label: t(n.key),
    section: n.section,
  }));
  const sections = (Object.keys(SECTION_LABEL_KEYS) as NavSection[])
    .map((section) => ({
      key: section,
      label: t(SECTION_LABEL_KEYS[section]),
      items: items.filter((item) => item.section === section),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <div className="bg-background min-h-screen">
      {/* role:"admin" so staff sessions can be filtered OUT of product
          analytics. Matches the server-side identify in requireAdmin. */}
      <PostHogIdentify distinctId={actor.id} email={actor.email} role="admin" />
      <AdminSidebar
        badge={badge}
        email={actor.email}
        sections={sections}
        counts={{
          "/admin/disputes": needsResponseDisputes,
          "/admin/notifications": failedNotifications,
        }}
      >
        {children}
      </AdminSidebar>
    </div>
  );
}
