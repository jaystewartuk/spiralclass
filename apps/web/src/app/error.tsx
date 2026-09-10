"use client";

import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { useSkewRecoveryOrReport } from "@/components/use-server-action-recovery";

// Route-segment error boundary. Catches errors thrown by any server
// component, client component, or server action under the (root)
// segment. Reporting to Sentry — so we see it alongside server errors
// captured by instrumentation.ts — happens inside useSkewRecoveryOrReport,
// which reports everything it does not recover from.

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  // Reloads once on a deploy-skew error, and reports anything it does not
  // recover from — including skew that has already used its one reload.
  const recovering = useSkewRecoveryOrReport(error);

  if (recovering) return null;

  return (
    <main className="container flex min-h-dvh flex-col items-center justify-center gap-6 py-12 text-center">
      <Link href="/" aria-label={t("common.brandName")}>
        <Logo size="md" />
      </Link>
      <div className="max-w-md space-y-3">
        <Heading level={1}>{t("common.error")}</Heading>
        <p className="text-muted-foreground">{t("web.errorBoundary.root.body")}</p>
        {error.digest && (
          <p className="text-muted-foreground text-xs">
            {t("web.errorBoundary.reference")}: <code>{error.digest}</code>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-3 lg:flex-row">
        <Button type="button" size="lg" onClick={reset}>
          {t("common.retry")}
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/">{t("web.errorBoundary.root.home")}</Link>
        </Button>
      </div>
    </main>
  );
}
