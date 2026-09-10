"use client";

import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { useSkewRecoveryOrReport } from "@/components/use-server-action-recovery";

// Group-level error boundary for the (student) surface. Keeps the throw
// from bubbling to the root boundary and losing the nav shell.

export default function StudentError({
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
      <Link href="/my-classes" aria-label={t("common.brandName")}>
        <Logo size="md" />
      </Link>
      <div className="max-w-md space-y-3">
        <Heading level={1}>{t("common.error")}</Heading>
        <p className="text-muted-foreground">{t("web.errorBoundary.student.body")}</p>
        {error.digest && (
          <p className="text-xs text-muted-foreground">
            {t("web.errorBoundary.reference")}: <code>{error.digest}</code>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-3 lg:flex-row">
        <Button type="button" size="lg" onClick={reset}>
          {t("common.retry")}
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/my-classes">{t("web.errorBoundary.student.home")}</Link>
        </Button>
      </div>
    </main>
  );
}
