"use client";

import type { LucideIcon } from "lucide-react";
import { NavRow, NavSectionHeading } from "@/components/nav/nav-row";

// The tablet-width home for the teacher app's nav: at 768-1023px there's
// enough vertical room for a persistent left rail, so the primary task list
// AND the "Your page"/"Materials"/"Settings" groups sit visible beside the
// page instead of behind a hamburger — the drawer stays only for true phone
// widths (see app-nav.tsx), and the full horizontal bar + dropdowns take over
// from 1280px up. Fixed under the sticky header (`top-14` matches its h-14)
// rather than sticky itself, since its own height already spans the viewport.

export type SidebarLink = {
  key: string;
  href: string;
  label: string;
  active?: boolean;
  external?: boolean;
  icon?: LucideIcon;
};

export type SidebarGroup = {
  label?: string;
  links: SidebarLink[];
};

export function TabletSidebarNav({
  navLabel,
  groups,
}: {
  navLabel: string;
  groups: SidebarGroup[];
}) {
  return (
    <aside
      aria-label={navLabel}
      className="border-border/60 bg-background desktop:block desktop-wide:hidden fixed inset-y-0 top-14 left-0 z-30 hidden w-56 overflow-y-auto border-r px-2 pt-4 pb-6"
    >
      <nav className="flex flex-col">
        {groups.map((group, i) => (
          <div key={group.label ?? i} className="contents">
            {group.label && <NavSectionHeading className="px-2">{group.label}</NavSectionHeading>}
            {group.links.map((link) => (
              <NavRow
                key={link.key}
                href={link.href}
                label={link.label}
                icon={link.icon}
                active={link.active}
                external={link.external}
                density="compact"
                // prefetch={false} is load-bearing, not a micro-optimization.
                // Unlike the phone drawer (mounted only while open) and the
                // desktop dropdowns (links rendered only while open), this
                // rail renders every group's links at once and is
                // `desktop:block`, so at those widths all ~24 are
                // simultaneously visible. At the Next default that fires ~24
                // RSC prefetches on every page load, each re-running the (app)
                // layout — ~24 concurrent React renders as one allocation
                // spike. That was a contributing load source in the
                // 2026-08-26 production outage (see fly.production.toml's
                // [[vm]] note). Nav targets are a deliberate tap away, so
                // eager prefetch buys little.
                prefetch={false}
              />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

// Matches the sidebar's own w-56 so the page content beside it (added by
// AppLayout) reserves exactly its width, and xl:pl-0 hands the space back
// once the sidebar itself disappears in favor of the horizontal desktop bar.
export const TABLET_SIDEBAR_CONTENT_OFFSET_CLASS = "lg:pl-56 xl:pl-0";
