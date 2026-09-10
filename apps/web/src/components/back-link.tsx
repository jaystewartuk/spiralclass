"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// Consistent in-app back affordance for detail pages. Mobile Safari hides its
// own back/forward chrome on scroll, so every non-top-level page needs its own
// obvious, thumb-reachable way back that doesn't depend on the browser's UI
// (§UX_UI_AUDIT IA-6). Uses router.back() so it preserves scroll position on
// the list the user came from, falling back to `href` (the canonical parent
// route) when there's no in-app history — e.g. a deep link from a
// notification, where back() would exit the app instead of going up a level.
export function BackLink({
  href,
  label,
  className,
}: {
  href: string;
  label: string;
  className?: string;
}) {
  const router = useRouter();

  return (
    <Link
      href={href}
      onClick={(e) => {
        if (window.history.length > 1) {
          e.preventDefault();
          router.back();
        }
      }}
      className={cn(
        "text-muted-foreground hover:text-foreground -ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium transition-colors",
        className,
      )}
    >
      <ChevronLeft className="h-5 w-5" aria-hidden />
      {label}
    </Link>
  );
}
