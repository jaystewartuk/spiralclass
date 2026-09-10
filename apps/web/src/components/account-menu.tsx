"use client";

import type { ReactNode } from "react";
import { useId } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, LifeBuoy, type LucideIcon, MessageCircle } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { SignOutButton } from "@/components/sign-out-button";
import { AccountBadge } from "@/components/account-badge";
import { AccountAvatar } from "@/components/account-avatar";
import { NavDivider, NavRow, NavSectionHeading, navRowClasses } from "@/components/nav/nav-row";
import { NavPreferences } from "@/components/nav/nav-preferences";
import { useMenuPopover } from "@/components/nav/use-menu-popover";
import { ReportProblemButton } from "@/components/report-problem-button";
import { WhatsAppSupportButton } from "@/components/whatsapp-support-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Account = {
  name?: string | null;
  email?: string | null;
  role?: "teacher" | "student" | "admin";
  photoUrl?: string | null;
};

export type AccountMenuLink = {
  href: string;
  label: string;
  active: boolean;
  icon?: LucideIcon;
};

// The desktop "account" cluster, collapsed into one avatar-triggered panel so
// the header bar stays focused on the primary task nav. It gathers the
// secondary destinations (Settings / Account), the support entries, the theme
// and language preferences, and sign out — everything that used to sit loose
// at the right edge of the bar.
//
// It renders the SAME parts as the phone drawer, in the same order, from the
// same primitives — identity, destinations, support, preferences, sign out.
// Two surfaces showing one menu is the point: what a teacher learns on her
// laptop is where she reaches on her phone.
//
// Keyboard, dismissal and focus behaviour live in useMenuPopover; see that
// file for why this is a disclosure rather than `role="menu"`.
export function AccountMenu({
  account,
  accountHref,
  links,
  linksLabel,
  localeToggle,
}: {
  account?: Account;
  /** Where the identity card at the top of the panel points. */
  accountHref?: string;
  // Secondary destinations shown under `linksLabel` (e.g. every settings page).
  links?: AccountMenuLink[];
  linksLabel?: string;
  localeToggle?: ReactNode;
}) {
  const t = useT();
  const menuId = useId();
  const { open, toggle, containerRef, triggerRef, panelRef, onPanelKeyDown, onContainerBlur } =
    useMenuPopover();

  const menuLabel = t("web.accountMenu.menuLabel");
  const fallback = t("web.accountBadge.fallback");
  const triggerName = account?.name?.trim() || account?.email?.trim() || fallback;
  const whatsappLabel = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP
    ? t("common.chatOnWhatsApp")
    : undefined;

  return (
    <div ref={containerRef} onBlur={onContainerBlur} className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={menuLabel}
        onClick={toggle}
        className={cn("gap-2 rounded-full pr-2 pl-1", open && "bg-muted/60")}
      >
        <AccountAvatar
          name={account?.name}
          email={account?.email}
          photoUrl={account?.photoUrl}
          size="sm"
        />
        <span className="hidden max-w-48 truncate xl:block">{triggerName}</span>
        <ChevronDown
          aria-hidden
          className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </Button>

      {open && (
        <div
          id={menuId}
          ref={panelRef}
          onKeyDown={onPanelKeyDown}
          aria-label={menuLabel}
          className="absolute right-0 z-50 mt-2 max-h-menu w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {account && accountHref && (
            <>
              <Link
                href={accountHref}
                className={navRowClasses({ density: "compact", className: "gap-3 py-2" })}
              >
                <AccountBadge
                  variant="full"
                  email={account.email}
                  name={account.name}
                  photoUrl={account.photoUrl}
                  className="min-w-0 flex-1"
                />
                <span className="sr-only">{t("web.nav.viewAccount")}</span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
              <NavDivider />
            </>
          )}

          {links && links.length > 0 && (
            <>
              {linksLabel && <NavSectionHeading>{linksLabel}</NavSectionHeading>}
              {links.map((link) => (
                <NavRow
                  key={link.href}
                  href={link.href}
                  label={link.label}
                  icon={link.icon}
                  active={link.active}
                  density="compact"
                />
              ))}
            </>
          )}

          <NavSectionHeading>{t("web.nav.support")}</NavSectionHeading>
          <ReportProblemButton
            label={t("common.reportProblem")}
            icon={LifeBuoy}
            density="compact"
            className={navRowClasses({ density: "compact" })}
          />
          {whatsappLabel && (
            <WhatsAppSupportButton
              label={whatsappLabel}
              icon={MessageCircle}
              density="compact"
              className={navRowClasses({ density: "compact" })}
            />
          )}

          <NavDivider />

          <NavPreferences localeToggle={localeToggle} className="px-3 pt-0 pb-3" />

          <SignOutButton label={t("common.signOut")} className="px-1 pb-1" />
        </div>
      )}
    </div>
  );
}
