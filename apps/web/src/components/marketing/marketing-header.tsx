import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { getLocalizedHref, getT } from "@/lib/i18n";

// The public marketing top nav — logo left, Features/Pricing links + sign-in
// CTA right. Extracted from the inline `<nav>` that page.tsx duplicated so the
// other marketing pages can adopt it. A server component: it resolves its own
// nav labels via getT(); auth resolution stays in the page, passed as
// `loggedInCta` (the sign-in button shows only for logged-out visitors, matching
// the original behavior).
export async function MarketingHeader({
  loggedInCta,
}: {
  loggedInCta?: { href: string; label: string } | null;
}) {
  const t = await getT();
  const href = await getLocalizedHref();
  return (
    <nav className="container flex items-center justify-between py-4">
      <Logo size="sm" />
      <div className="flex items-center gap-4 text-sm">
        <Link
          href={href("/features")}
          className="hidden text-muted-foreground transition-colors hover:text-foreground sm:inline"
        >
          {t("web.landing.nav.features")}
        </Link>
        <Link
          href={href("/pricing")}
          className="hidden text-muted-foreground transition-colors hover:text-foreground sm:inline"
        >
          {t("web.landing.nav.pricing")}
        </Link>
        {!loggedInCta && (
          <Button asChild size="sm" variant="outline">
            {/* A full load, not a client-side navigation: sign-in follows the
                reader's own language, which a page at `/es/…` need not be in,
                and the root layout that carries the language is only
                re-rendered by a full load (D-193). */}
            <a href="/sign-in">{t("web.signIn.title")}</a>
          </Button>
        )}
      </div>
    </nav>
  );
}
