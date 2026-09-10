"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ChevronDown,
  ChevronRight,
  LifeBuoy,
  type LucideIcon,
  Menu,
  MessageCircle,
  X,
} from "lucide-react";
import { AccountBadge } from "@/components/account-badge";
import { Logo } from "@/components/brand/logo";
import { useT } from "@/components/locale-provider";
import { NavDivider, NavRow, NavSectionHeading, navRowClasses } from "@/components/nav/nav-row";
import { NavPreferences } from "@/components/nav/nav-preferences";
import { ReportProblemButton } from "@/components/report-problem-button";
import { SignOutButton } from "@/components/sign-out-button";
import { WhatsAppSupportButton } from "@/components/whatsapp-support-button";
import { Button } from "@/components/ui/button";
import { DESKTOP_MIN_WIDTH } from "@/lib/breakpoints";
import { cn } from "@/lib/utils";

// The phone/tablet navigation drawer, shared by the teacher shell
// (app-nav.tsx) and the student portal (student-nav.tsx) — same markup, same
// behaviour, only the sections differ.
//
// It is a real MODAL DIALOG (Radix), where it used to be a block of markup
// revealed under the header. That is not a stylistic upgrade; four things were
// broken and all four are properties of the dialog primitive rather than
// anything worth hand-rolling:
//
//   * the page behind it still scrolled, so flicking the drawer's own list
//     often scrolled the page underneath instead;
//   * focus was never moved into it and never trapped, so a keyboard user
//     tabbed from the hamburger straight into the page behind the open menu,
//     and a screen-reader user was given no indication the menu had opened;
//   * nothing marked the rest of the page inert, so assistive tech read the
//     drawer as one more region of a page it was actually covering;
//   * dismissal was a hand-written pointerdown/Escape listener pair, on top of
//     which focus was never returned to the trigger.
//
// A comment in app-nav.tsx claimed "the body scroll is locked while open". It
// was not, and now it is.

export type MobileNavRow = {
  key: string;
  href: string;
  label: string;
  active?: boolean;
  external?: boolean;
  icon?: LucideIcon;
  /** A badge pinned to the right of the row (the unread notification count). */
  trailing?: ReactNode;
};

export type MobileNavSection = {
  label?: string;
  rows: MobileNavRow[];
  /**
   * Wraps the section in a disclosure that starts closed, unless one of its own
   * rows is the current page — used for the lower-priority teacher groups
   * ("Your page", "Materials", "Settings") so the drawer opens short and she
   * expands only the group she's after. The primary section (no label) is never
   * collapsible: it's the day-to-day nav, always in view.
   */
  collapsible?: boolean;
};

export function MobileNavToggle({
  open,
  onToggle,
  controls,
  openLabel,
  closeLabel,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  openLabel: string;
  closeLabel: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? closeLabel : openLabel}
      onClick={onToggle}
      className="shrink-0 text-foreground desktop:hidden"
    >
      {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
    </Button>
  );
}

/**
 * Close the drawer if the viewport grows into the desktop layout while it is
 * open — at that width the header shows its own nav and the trigger is gone,
 * which would otherwise leave a modal on screen with nothing that opened it.
 * The query is built from the same constant `SCREENS.desktop` is, so the two
 * cannot drift.
 */
function useCloseOnDesktop(open: boolean, onOpenChange: (open: boolean) => void) {
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px) and (pointer: fine)`);
    if (query.matches) {
      onOpenChange(false);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) onOpenChange(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open, onOpenChange]);
}

function DrawerSection({ section }: { section: MobileNavSection }) {
  const anyActive = section.rows.some((row) => row.active);
  // Seeded once per mount. The drawer's content unmounts on close, so this
  // recomputes — open whenever it holds the current page — every time the
  // drawer is opened, with no effect needed to re-sync it.
  const [open, setOpen] = useState(() => anyActive || !section.collapsible);
  const listId = useId();

  // No display utility on this wrapper, deliberately: Tailwind's preflight
  // rule for the `hidden` ATTRIBUTE lives in the base layer, so a `flex` class
  // here would out-rank it and the collapsed group would stay on screen. The
  // rows are block-level in normal flow and need no container display.
  const rows = (
    <div id={listId} hidden={section.collapsible ? !open : undefined}>
      {section.rows.map((row) => (
        <NavRow
          key={row.key}
          href={row.href}
          label={row.label}
          icon={row.icon}
          active={row.active}
          external={row.external}
          trailing={row.trailing}
        />
      ))}
    </div>
  );

  if (!section.collapsible) {
    return (
      <>
        {section.label && <NavSectionHeading>{section.label}</NavSectionHeading>}
        {rows}
      </>
    );
  }

  return (
    <>
      <h3>
        <Button
          type="button"
          variant="ghost"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className="w-full justify-between px-3 text-xs font-bold text-muted-foreground hover:text-foreground"
        >
          {section.label}
          <ChevronDown
            aria-hidden
            className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </Button>
      </h3>
      {rows}
    </>
  );
}

/** Everything inside the drawer, split from the Radix chrome so each half
 * reads as one thing: the dialog's behaviour above, the menu's contents here. */
function MobileNavContent({
  navLabel,
  account,
  accountHref,
  sections,
  localeToggle,
}: {
  navLabel: string;
  account?: { name?: string | null; email?: string | null; photoUrl?: string | null };
  accountHref?: string;
  sections: MobileNavSection[];
  localeToggle?: ReactNode;
}) {
  const t = useT();
  const whatsappLabel = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP
    ? t("common.chatOnWhatsApp")
    : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
      {/* Who am I signed in as — and one tap to the page that answers it.
          The same block was previously inert decoration. */}
      {account && accountHref && (
        <>
          <Link href={accountHref} className={navRowClasses({ className: "mt-3 gap-3" })}>
            <AccountBadge
              variant="full"
              name={account.name}
              email={account.email}
              photoUrl={account.photoUrl}
              className="min-w-0 flex-1"
            />
            <span className="sr-only">{t("web.nav.viewAccount")}</span>
            <ChevronRight aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
          </Link>
          <NavDivider />
        </>
      )}

      <nav aria-label={navLabel}>
        {sections.map((section, i) => (
          <DrawerSection key={section.label ?? i} section={section} />
        ))}
      </nav>

      <NavDivider />

      <NavSectionHeading className="pt-0">{t("web.nav.support")}</NavSectionHeading>
      <ReportProblemButton
        label={t("common.reportProblem")}
        icon={LifeBuoy}
        className={navRowClasses()}
      />
      {whatsappLabel && (
        <WhatsAppSupportButton
          label={whatsappLabel}
          icon={MessageCircle}
          className={navRowClasses()}
        />
      )}

      <NavDivider />

      <NavPreferences localeToggle={localeToggle} className="px-3 pt-1 pb-4" />

      <SignOutButton label={t("common.signOut")} className="w-full" />
    </div>
  );
}

export function MobileNavDrawer({
  id,
  open,
  onOpenChange,
  navLabel,
  account,
  accountHref,
  sections,
  localeToggle,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navLabel: string;
  account?: { name?: string | null; email?: string | null; photoUrl?: string | null };
  accountHref?: string;
  sections: MobileNavSection[];
  localeToggle?: ReactNode;
}) {
  const t = useT();
  useCloseOnDesktop(open, onOpenChange);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-xs data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          id={id}
          // The drawer's only content is navigation, which needs no prose
          // description; without this Radix warns for a missing one.
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sheet flex-col border-l border-border bg-card text-card-foreground shadow-brand-lg duration-300 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right motion-reduce:animate-none sm:max-w-sm"
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 pr-2 pl-4">
            <DialogPrimitive.Title className="sr-only">{t("web.nav.menu")}</DialogPrimitive.Title>
            <Logo size="sm" />
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("common.close")}
                className="shrink-0 text-foreground"
              >
                <X className="h-6 w-6" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <MobileNavContent
            navLabel={navLabel}
            account={account}
            accountHref={accountHref}
            sections={sections}
            localeToggle={localeToggle}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
