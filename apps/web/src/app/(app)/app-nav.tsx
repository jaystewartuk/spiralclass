"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { NAV_GROUP_LABELS } from "@spiralclass/shared";
import { Logo } from "@/components/brand/logo";
import { useLocale, useT } from "@/components/locale-provider";
import { AccountMenu } from "@/components/account-menu";
import { PageMenu } from "@/components/page-menu";
import { NavBarLink } from "@/components/nav/nav-row";
import {
  MobileNavDrawer,
  MobileNavToggle,
  type MobileNavSection,
} from "@/components/nav/mobile-nav-drawer";
import { TabletSidebarNav, type SidebarGroup } from "@/components/tablet-sidebar-nav";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { isWebNavActive, webAccountMenuLinks, webNavGroup } from "@/lib/nav";
import { navIcon } from "@/lib/nav-icons";
import { cn } from "@/lib/utils";

type Account = {
  name?: string | null;
  email?: string | null;
  role?: "teacher" | "student" | "admin";
  photoUrl?: string | null;
};

const MOBILE_MENU_ID = "app-mobile-menu";
const ACCOUNT_HREF = "/settings/account";

export function AppNav({
  localeToggle,
  account,
  bookingSlug,
  unreadCount = 0,
}: {
  localeToggle?: ReactNode;
  account?: Account;
  // The teacher's public booking slug, so the "Your page" menu can link out to
  // the live page. Absent during provisioning → the link degrades to "#".
  bookingSlug?: string;
  unreadCount?: number;
}) {
  const pathname = usePathname();
  const locale = useLocale();
  const t = useT();
  const [open, setOpen] = useState(false);

  // Collapse the mobile menu on navigation so a tapped link doesn't leave the
  // drawer hanging over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Onboarding has its own focused stepper layout — no app chrome there.
  if (pathname.startsWith("/onboarding")) return null;

  // The header surfaces, all resolved from the one shared IA model:
  //  - primary: the day-to-day task bar (Dashboard / Calendar / Classes / …).
  //  - pagina:  the "Your page" dropdown (Leads / Testimonials / …).
  //  - account: the settings destinations, listed in the avatar menu and in
  //             the drawer's collapsed "Settings" group.
  const primary = webNavGroup("main", locale);
  const pagina = webNavGroup("page", locale, { bookingSlug });
  const contenido = webNavGroup("content", locale);
  const accountLinks = webAccountMenuLinks(locale);

  const navLabel = t("web.appNav.mainNavigation");
  const notifBaseLabel = t("web.appNav.notifications");
  const notifLabel =
    unreadCount > 0 ? t("web.appNav.notificationsUnread", { count: unreadCount }) : notifBaseLabel;
  const notificationsActive = pathname.startsWith("/notifications");
  const paginaLabel = NAV_GROUP_LABELS.page[locale];
  const contenidoLabel = NAV_GROUP_LABELS.content[locale];
  const configLabel = NAV_GROUP_LABELS.config[locale];

  // One row shape feeds both the phone drawer and the tablet sidebar — same
  // links, same icons, same active state, two containers for two widths.
  const toRow = (item: (typeof primary)[number]) => ({
    key: item.key,
    href: item.href,
    label: item.label,
    active: isWebNavActive(item, pathname),
    external: item.external,
    icon: navIcon(item.key),
  });

  // Notifications lead the drawer's primary list rather than sitting above it
  // as a one-off row: it is a destination like any other, and the unread count
  // rides along as the row's trailing badge.
  const notificationsRow = {
    key: "notifications-inbox",
    href: "/notifications",
    label: notifBaseLabel,
    active: notificationsActive,
    icon: Bell,
    trailing: <UnreadBadge count={unreadCount} />,
  };

  const sections: MobileNavSection[] = [
    { rows: [notificationsRow, ...primary.map(toRow)] },
    // Collapsible: closed by default unless the current page lives in the
    // group, so the drawer opens short instead of a full scroll of every
    // group's items every time.
    { label: paginaLabel, rows: pagina.map(toRow), collapsible: true },
    { label: contenidoLabel, rows: contenido.map(toRow), collapsible: true },
    { label: configLabel, rows: accountLinks.map(toRow), collapsible: true },
  ];

  const sidebarGroups: SidebarGroup[] = [
    { links: primary.map(toRow) },
    { label: paginaLabel, links: pagina.map(toRow) },
    { label: contenidoLabel, links: contenido.map(toRow) },
    { label: configLabel, links: accountLinks.map(toRow) },
  ];

  const bell = (
    <Link
      href="/notifications"
      aria-label={notifLabel}
      aria-current={notificationsActive ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-3 focus-visible:outline-none lg:h-10 lg:w-10",
        notificationsActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Bell className="h-5 w-5" />
      <UnreadBadge count={unreadCount} className="absolute -top-0.5 -right-0.5" />
    </Link>
  );

  return (
    <>
      <header className="border-border/60 bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
        <div className="container flex h-14 items-center justify-between gap-4">
          <Link href="/dashboard" aria-label={t("common.brandName")} className="shrink-0">
            <Logo size="sm" />
          </Link>

          {/* Desktop (1280px+, mouse): inline horizontal nav. Tablet widths get
          the persistent sidebar below instead — this bar would have nowhere
          good to put four groups' worth of links — and phones get the drawer. */}
          <nav aria-label={navLabel} className="desktop-wide:flex hidden flex-1 items-center gap-1">
            {primary.map((item) => (
              <NavBarLink
                key={item.key}
                href={item.href}
                label={item.label}
                active={isWebNavActive(item, pathname)}
              />
            ))}
            <PageMenu links={pagina} label={paginaLabel} />
            <PageMenu links={contenido} label={contenidoLabel} />
          </nav>

          {/* The alerts bell sits beside the account menu at every width — it's
          a primary affordance, not something to bury in the menu. */}
          <div className="flex shrink-0 items-center gap-1">
            {bell}
            <div className="desktop:block hidden">
              <AccountMenu
                account={account}
                accountHref={ACCOUNT_HREF}
                localeToggle={localeToggle}
                linksLabel={configLabel}
                links={accountLinks.map((item) => ({
                  href: item.href,
                  label: item.label,
                  active: isWebNavActive(item, pathname),
                  icon: navIcon(item.key),
                }))}
              />
            </div>
            <MobileNavToggle
              open={open}
              onToggle={() => setOpen((v) => !v)}
              controls={MOBILE_MENU_ID}
              openLabel={t("web.appNav.openMenu")}
              closeLabel={t("web.appNav.closeMenu")}
            />
          </div>
        </div>

        <MobileNavDrawer
          id={MOBILE_MENU_ID}
          open={open}
          onOpenChange={setOpen}
          navLabel={navLabel}
          account={account}
          accountHref={ACCOUNT_HREF}
          sections={sections}
          localeToggle={localeToggle}
        />
      </header>

      {/* Tablet widths: a persistent sidebar instead of stretching the phone
      drawer across a screen wide enough to just show the nav. Hidden itself
      outside that range (see TabletSidebarNav) — AppLayout reserves its width
      in the content column with TABLET_SIDEBAR_CONTENT_OFFSET_CLASS. */}
      <TabletSidebarNav navLabel={navLabel} groups={sidebarGroups} />
    </>
  );
}
