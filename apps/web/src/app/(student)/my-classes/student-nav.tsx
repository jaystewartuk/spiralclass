"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { useLocale, useT } from "@/components/locale-provider";
import { AccountMenu } from "@/components/account-menu";
import { NavBarLink } from "@/components/nav/nav-row";
import {
  MobileNavDrawer,
  MobileNavToggle,
  type MobileNavSection,
} from "@/components/nav/mobile-nav-drawer";
import {
  STUDENT_ACCOUNT_HREF,
  STUDENT_ACCOUNT_KEYS,
  STUDENT_PRIMARY_KEYS,
  studentNavLinks,
  type StudentNavLink,
} from "@/lib/student-nav";

type Account = {
  name?: string | null;
  email?: string | null;
  role?: "teacher" | "student" | "admin";
  photoUrl?: string | null;
};

const MOBILE_MENU_ID = "student-mobile-menu";

// The student portal's header. Which destinations exist, what they're called
// and which icon stands for each lives in lib/student-nav.ts — this file is
// only the three containers they render into: the desktop bar, the avatar
// menu, and the phone drawer.
export function StudentNav({
  localeToggle,
  account,
}: {
  localeToggle?: ReactNode;
  account?: Account;
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

  const navLabel = t("web.studentNav.mainNavigation");
  const primary = studentNavLinks(STUDENT_PRIMARY_KEYS, locale, pathname);
  const accountLinks = studentNavLinks(STUDENT_ACCOUNT_KEYS, locale, pathname);

  const toRow = (link: StudentNavLink) => ({
    key: link.key,
    href: link.href,
    label: link.label,
    active: link.active,
    icon: link.icon,
  });

  // One flat section: seven destinations is a list a student can read at a
  // glance, and grouping it would add headings without removing anything.
  const sections: MobileNavSection[] = [{ rows: [...primary, ...accountLinks].map(toRow) }];

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="container flex h-14 max-w-3xl items-center justify-between gap-4">
        <Link href="/my-classes" aria-label={t("common.brandName")} className="shrink-0">
          <Logo size="sm" />
        </Link>

        {/* Desktop: inline horizontal nav. Replaced by the drawer on mobile. */}
        <nav aria-label={navLabel} className="hidden flex-1 items-center gap-1 desktop:flex">
          {primary.map((link) => (
            <NavBarLink key={link.key} href={link.href} label={link.label} active={link.active} />
          ))}
        </nav>

        {/* Desktop: account, language, appearance and sign out in one menu. */}
        <div className="hidden shrink-0 items-center desktop:flex">
          <AccountMenu
            account={account}
            accountHref={STUDENT_ACCOUNT_HREF}
            localeToggle={localeToggle}
            links={accountLinks.map((link) => ({
              href: link.href,
              label: link.label,
              active: link.active,
              icon: link.icon,
            }))}
          />
        </div>

        {/* Mobile: a single roomy toggle keeps the bar uncluttered. */}
        <MobileNavToggle
          open={open}
          onToggle={() => setOpen((v) => !v)}
          controls={MOBILE_MENU_ID}
          openLabel={t("web.studentNav.openMenu")}
          closeLabel={t("web.studentNav.closeMenu")}
        />
      </div>

      <MobileNavDrawer
        id={MOBILE_MENU_ID}
        open={open}
        onOpenChange={setOpen}
        navLabel={navLabel}
        account={account}
        accountHref={STUDENT_ACCOUNT_HREF}
        sections={sections}
        localeToggle={localeToggle}
      />
    </header>
  );
}
