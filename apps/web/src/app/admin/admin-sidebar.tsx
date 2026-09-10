"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/sign-out-button";
import { AccountBadge } from "@/components/account-badge";
import { AccountMenu } from "@/components/account-menu";
import { AdminQuickSearch } from "./admin-quick-search";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";

type NavItem = { href: string; label: string };
type NavSection = { key: string; label: string; items: NavItem[] };
type BadgeInfo = { label: string; variant: "warning" | "success" | "info" };

// Grouped left sidebar (D-6x "supercharge the nav bar") — replaces the old
// flat top bar (5 always-visible + 10 collapsed into an account dropdown),
// which was already straining at 15 destinations across 5 admin roles. Every
// section renders as a labelled group instead of splitting across two
// surfaces, and there's room for a 6th section before this needs revisiting.
export function AdminSidebar({
  badge,
  email,
  sections,
  counts,
  children,
}: {
  badge: BadgeInfo;
  email: string;
  sections: NavSection[];
  /** Live health counts keyed by nav href — renders as a small pill when > 0. */
  counts?: Record<string, number>;
  children: ReactNode;
}) {
  const t = useT();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Collapse the mobile drawer on navigation so a tapped link doesn't leave
  // the panel hanging open over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isActive = (item: NavItem) =>
    item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);

  function renderLink(item: NavItem, mobile = false) {
    const count = counts?.[item.href] ?? 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={isActive(item) ? "page" : undefined}
        className={cn(
          "flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors",
          mobile ? "py-3 text-base" : "",
          isActive(item)
            ? "bg-muted text-foreground font-medium"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <span>{item.label}</span>
        {count > 0 ? (
          <span className="bg-destructive text-destructive-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-sm leading-none font-semibold">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Link>
    );
  }

  function renderSections(mobile = false) {
    return sections.map((section) => (
      <div
        key={section.key}
        className="border-border/40 space-y-1 border-t pt-4 first:border-t-0 first:pt-0"
      >
        {/* Not a link — deliberately lighter/looser than the nav items below
            it (no hover state, faded color, wide tracking) so it reads as a
            group label rather than another row in the list. */}
        <div className="text-subtle px-3 pb-1 text-sm font-semibold select-none">
          {section.label}
        </div>
        {section.items.map((item) => renderLink(item, mobile))}
      </div>
    ));
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-border/60 flex h-14 shrink-0 items-center justify-between gap-4 border-b px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="admin-mobile-sidebar"
            aria-label={open ? t("web.admin.nav.closeMenu") : t("web.admin.nav.openMenu")}
            onClick={() => setOpen((v) => !v)}
            className="text-foreground hover:bg-muted/60 desktop:hidden inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <Link href="/admin" aria-label={t("web.admin.nav.brandAriaLabel")} className="shrink-0">
            <Logo size="sm" />
          </Link>
          <Badge variant={badge.variant} className="shrink-0">
            {badge.label}
          </Badge>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Quick jump. Gated on `roomy` rather than the desktop tier: the
              drawer stays a flat list with no room for a search box, so a `md:`
              gate would delete the only way to jump to a record on every tablet
              and every narrow window — and unlike the nav, this one has no
              drawer equivalent to fall back to. Collapsed it is a 36px icon
              button, so 640px is ample. */}
          <div className="hidden sm:block">
            <AdminQuickSearch />
          </div>
          <div className="desktop:block hidden">
            <AccountMenu account={{ email, role: "admin" }} />
          </div>
        </div>
      </header>

      {/* min-h-0 lets this row's flex children size to the remaining
          viewport height instead of growing with their content — without it,
          the sidebar and main content scroll together as one page, so
          clicking a sidebar item while scrolled down jumps the whole page
          (sidebar included) back to the top on navigation. */}
      <div className="flex min-h-0 flex-1">
        {/* Desktop: fixed grouped sidebar, scrolls independently of main. */}
        <nav
          aria-label={t("web.admin.nav.ariaLabel")}
          className="border-border/60 desktop:block hidden w-56 shrink-0 overflow-y-auto border-r p-3"
        >
          {renderSections()}
        </nav>

        {/* Mobile: off-canvas drawer with the same grouped sections plus
            identity + sign out, since mobile has no account dropdown. */}
        {open ? (
          <div className="desktop:hidden fixed inset-0 z-40">
            <div
              className="bg-foreground/20 absolute inset-0"
              aria-hidden
              onClick={() => setOpen(false)}
            />
            <div
              id="admin-mobile-sidebar"
              className="max-w-sheet border-border/60 bg-background absolute top-0 left-0 flex h-full w-72 flex-col overflow-y-auto border-r p-3"
            >
              <nav aria-label={t("web.admin.nav.ariaLabel")} className="flex-1 space-y-1">
                {renderSections(true)}
              </nav>
              <div className="border-border/60 mt-4 flex items-center justify-between gap-3 border-t pt-3">
                <AccountBadge variant="full" email={email} />
                <SignOutButton label={t("common.signOut")} />
              </div>
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 overflow-x-auto overflow-y-auto p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
