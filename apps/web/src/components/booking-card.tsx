import Link from "next/link";
import type { ReactNode } from "react";

// Booking card:
// a bold title + status badge up top, the date/time line, then a footer row
// with the package/duration meta and an optional materials badge.
export function BookingCard({
  href,
  title,
  when,
  whenSecondary,
  meta,
  status,
  materials,
  children,
}: {
  href: string;
  title: string;
  /** The viewer's own local time — rendered visually dominant (see whenSecondary). */
  when: ReactNode;
  /**
   * The other participant's local time — always rendered directly under
   * `when`, visually secondary (smaller/lighter), per the dual-timezone
   * display standard: every class time shows both the viewer's own local
   * time and the other participant's, even when the two match.
   */
  whenSecondary?: ReactNode;
  meta?: string;
  status: ReactNode;
  materials?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="bg-card hover:bg-muted/40 block rounded-lg border px-4 py-3 shadow-sm transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-display min-w-0 truncate text-base font-semibold">{title}</span>
        {status}
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{when}</p>
      {whenSecondary && <p className="text-subtle text-xs">{whenSecondary}</p>}
      {(meta || materials) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {meta ? <span className="text-muted-foreground text-xs">{meta}</span> : <span />}
          {materials}
        </div>
      )}
      {children}
    </Link>
  );
}
