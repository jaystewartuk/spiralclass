import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { getT } from "@/lib/i18n";

/**
 * The top bar of a signed-in help page: the wordmark home, and the way back to
 * whichever part of the app the reader came from.
 *
 * Shared by the audience index and the article page so the two cannot drift —
 * they held two copies of this markup, and the copies had already started to.
 */
export async function HelpPageHeader({
  backHref,
  backLabel,
}: {
  backHref: string;
  backLabel: string;
}) {
  const t = await getT();
  return (
    <div className="flex items-center justify-between gap-4">
      <Link href="/" aria-label={t("common.brandName")} className="inline-block rounded-sm">
        <Logo size="sm" />
      </Link>
      <Link
        href={backHref}
        className="rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        {backLabel}
      </Link>
    </div>
  );
}
