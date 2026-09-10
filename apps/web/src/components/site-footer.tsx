"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import { SOURCE_CODE_URL } from "@spiralclass/shared";

export function SiteFooter({ localeToggle }: { localeToggle?: ReactNode }) {
  const pathname = usePathname();
  const t = useT();

  const hidden =
    pathname.startsWith("/admin") ||
    pathname.startsWith("/onboarding") ||
    // A conversation is a full-height shell whose composer is pinned to the
    // bottom edge. A footer under it does not sit "below the fold" — it makes
    // the whole thread scrollable as a document, so dragging the message list
    // past its end pulls the composer up off the screen.
    pathname.startsWith("/dashboard/messages") ||
    pathname.startsWith("/my-classes/messages") ||
    /^\/b\/[^/]+\/buy/.test(pathname);

  if (hidden) return null;

  // The teacher app shell (dashboard/settings/payments) keeps its unchanged
  // desktop experience — no footer, same as before — but now matches the
  // student portal's mobile-web pattern of always showing the shared footer
  // below the fold on small screens, where there's no bottom tab bar taking
  // its place anymore.
  const mobileOnly =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/payments");

  const year = new Date().getFullYear();

  return (
    <footer className={cn("mt-12 border-t", mobileOnly && "lg:hidden")}>
      <div className="container flex flex-col items-center gap-5 py-8 text-center">
        {/* Wordmark — gives the footer a little brand presence */}
        <span className="font-display text-sm font-semibold text-foreground/70">SpiralClass</span>

        {/* Page links — generous spacing so they breathe when they wrap on mobile */}
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <a href="/about" className="transition-colors hover:text-foreground">
            {t("web.siteFooter.about")}
          </a>
          <a href="/features" className="transition-colors hover:text-foreground">
            {t("web.siteFooter.features")}
          </a>
          <a href="/pricing" className="transition-colors hover:text-foreground">
            {t("web.siteFooter.pricing")}
          </a>
          <Link href="/help" className="transition-colors hover:text-foreground">
            {t("web.siteFooter.help")}
          </Link>
          <a href="/terms" className="transition-colors hover:text-foreground">
            {t("web.siteFooter.terms")}
          </a>
          <a href="/privacy-notice" className="transition-colors hover:text-foreground">
            {t("web.siteFooter.privacy")}
          </a>
          {/* The repository is public (AGPL-3.0-only) and the site says so —
              the same claim the /about trust grid makes, put where a reader
              looking for it will look. Off-site, so it opens in a new tab. */}
          <a
            href={SOURCE_CODE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-foreground"
          >
            {t("web.siteFooter.sourceCode")}
          </a>
        </nav>

        {/* Preferences — language + theme, grouped into a pill so they read as
            settings rather than more navigation. */}
        <div className="flex items-center gap-3 rounded-full border bg-muted/30 px-4 py-1.5">
          {localeToggle}
          <span className="h-3.5 w-px bg-border" aria-hidden />
          <ThemeToggle />
        </div>

        <p className="text-sm text-subtle">© {year} SpiralClass</p>

        <p className="text-sm text-subtle">
          {t("web.siteFooter.madeBy")}{" "}
          <a
            href="https://jaystewart.co.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-foreground"
          >
            Jay Stewart
          </a>
        </p>
      </div>
    </footer>
  );
}
