"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ONE navigation row, for every surface that lists destinations: the phone
// drawer, the tablet sidebar, and the two desktop dropdowns. Before this the
// four hand-rolled their own row — same idea, four sets of paddings, three
// different active states, and focus rings on none of them — which is why a
// student's drawer was a wall of undifferentiated text while the teacher's had
// icons.
//
// Two densities, because the two contexts are genuinely different and nothing
// else is:
//
//   comfortable  a finger on a phone. 44px minimum target (D-140), 17px label.
//   compact      a cursor on a desktop dropdown or the tablet rail. 40px,
//                15px label — the same step the Button primitive drops to at
//                `lg`.
//
// Labels WRAP rather than truncate. French runs ~20% longer than English and
// "Modèles de contenu de cours" in a 224px rail has to go somewhere; D-140
// settled that question in favour of wrapping over any of the alternatives
// (clipping, ellipsis, a condensed face).

export type NavRowDensity = "comfortable" | "compact";

/**
 * The row's own classes, exported because two rows in the menus are BUTTONS
 * rather than links (report a problem, WhatsApp support) and have to look
 * identical to their neighbours.
 */
export function navRowClasses({
  active,
  density = "comfortable",
  className,
}: {
  active?: boolean;
  density?: NavRowDensity;
  className?: string;
} = {}): string {
  return cn(
    "group relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
    "focus-visible:ring-ring focus-visible:ring-3 focus-visible:outline-none",
    density === "comfortable" ? "min-h-target text-base" : "min-h-10 text-sm",
    active
      ? "bg-muted text-foreground font-semibold"
      : "text-foreground hover:bg-muted/60 font-medium",
    className,
  );
}

/**
 * The active marker. A tinted ground alone is easy to miss on a glance and
 * disappears entirely for anyone who has turned colour down; the bar is a
 * second, positional cue for the same fact `aria-current` states for a screen
 * reader.
 */
export function NavRowIndicator({ active }: { active?: boolean }) {
  if (!active) return null;
  return <span aria-hidden className="bg-primary absolute inset-y-2 left-0 w-1 rounded-full" />;
}

export function NavRowIcon({
  icon: Icon,
  active,
  density = "comfortable",
}: {
  icon?: LucideIcon;
  active?: boolean;
  density?: NavRowDensity;
}) {
  if (!Icon) return null;
  return (
    <Icon
      aria-hidden
      className={cn(
        "shrink-0 transition-colors",
        density === "comfortable" ? "h-5 w-5" : "h-4 w-4",
        active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
      )}
    />
  );
}

export function NavRowLabel({ children }: { children: ReactNode }) {
  return <span className="min-w-0 flex-1">{children}</span>;
}

export function NavRow({
  href,
  label,
  icon,
  active,
  external,
  density = "comfortable",
  trailing,
  prefetch,
  className,
  onClick,
}: {
  href: string;
  label: ReactNode;
  icon?: LucideIcon;
  active?: boolean;
  external?: boolean;
  density?: NavRowDensity;
  /** A badge or hint pinned to the right edge (e.g. the unread count). */
  trailing?: ReactNode;
  /** Passed through so the tablet rail can keep its deliberate `false`. */
  prefetch?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={navRowClasses({ active, density, className })}
    >
      <NavRowIndicator active={active} />
      <NavRowIcon icon={icon} active={active} density={density} />
      <NavRowLabel>{label}</NavRowLabel>
      {trailing}
    </Link>
  );
}

/** A hairline between two groups of rows, inset to the rows' own text column.
 * `shrink-0` because a 1px flex item in an overflowing column is the first
 * thing the layout takes back — which is exactly where a menu is long enough
 * to need dividers. */
export function NavDivider() {
  return <div aria-hidden className="bg-border/60 mx-3 my-2 h-px shrink-0" />;
}

/**
 * A destination in the DESKTOP header bar. Same active vocabulary as the rows
 * — tinted ground plus a heavier weight, `aria-current` for a screen reader —
 * in the one shape a horizontal bar can carry.
 */
export function NavBarLink({
  href,
  label,
  active,
  prefetch,
}: {
  href: string;
  label: ReactNode;
  active?: boolean;
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:outline-none",
        active
          ? "bg-muted text-foreground font-semibold"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground font-medium",
      )}
    >
      {label}
    </Link>
  );
}

/**
 * A group label. Static text, not a fifth link — bold and set on the muted
 * step so it reads as a caption above its rows rather than another
 * destination. Sentence case, never uppercase: capitals remove the word-shape
 * cue a struggling reader leans on (D-140).
 */
export function NavSectionHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h3 className={cn("text-muted-foreground px-3 pt-4 pb-1 text-xs font-bold", className)}>
      {children}
    </h3>
  );
}
