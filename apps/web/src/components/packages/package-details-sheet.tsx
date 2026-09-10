"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { useLocale, useT } from "@/components/locale-provider";
import { formatMinorUnits } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { StringKey } from "@/lib/i18n-translate";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

type PackageDetails = {
  id: string;
  templateName: string | null;
  subject: string | null;
  classesTotal: number;
  classesUsed: number;
  classesLeftToTeach: number;
  status: string;
  purchasedAt: string;
  expiresAt: string | null;
  counterpart: { id: string; name: string; role: "teacher" | "student" } | null;
  price: { amountMinorUnits: number; currency: string } | null;
};

const STATUS_VARIANT: Record<string, BadgeProps["variant"]> = {
  active: "success",
  paused: "warning",
  pending: "info",
  expired: "secondary",
  refunded: "destructive",
};

const STATUS_KEY: Record<string, StringKey> = {
  active: "package.status.active",
  paused: "package.status.paused",
  pending: "package.status.pending",
  expired: "package.status.expired",
  refunded: "package.status.refunded",
};

// The one reusable "view more about this package" surface — wraps whatever
// summary a caller already renders (a row, a card, a line of text) and turns
// it into a trigger for a slide-over with the full picture. Details are
// fetched lazily from /api/packages/[id] (viewer-scoped server-side) only
// once the sheet is actually opened, so list pages with many packages never
// pay for data nobody looks at.
export function PackageDetailsSheet({
  packageId,
  children,
  className,
}: {
  packageId: string;
  children: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PackageDetails | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next || data || status === "loading") return;
    setStatus("loading");
    try {
      const res = await fetchWithTimeout(`/api/packages/${packageId}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      setData((await res.json()) as PackageDetails);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const title = data?.templateName ?? data?.subject ?? t("web.packageDetails.customPackage");

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <button
          type="button"
          className={cn(
            "hover:bg-muted/40 block w-full rounded-lg text-left transition-colors",
            className,
          )}
        >
          {children}
        </button>
      </SheetTrigger>
      <SheetContent className="max-w-md">
        <SheetHeader>
          <SheetTitle>{status === "loading" ? t("common.loading") : title}</SheetTitle>
          {data?.subject && data.templateName && (
            <SheetDescription>{data.subject}</SheetDescription>
          )}
        </SheetHeader>

        {status === "loading" && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" aria-hidden />
          </div>
        )}

        {status === "error" && (
          <p className="text-destructive text-sm">{t("web.packageDetails.loadError")}</p>
        )}

        {data && status !== "loading" && (
          <div className="space-y-5">
            <Badge variant={STATUS_VARIANT[data.status] ?? "secondary"}>
              {t(STATUS_KEY[data.status] ?? "package.status.pending")}
            </Badge>

            <div className="grid grid-cols-2 gap-3">
              <Stat
                label={t("web.packageDetails.classesTotal")}
                value={String(data.classesTotal)}
              />
              <Stat
                label={t("web.packageDetails.classesRemaining")}
                value={String(data.classesLeftToTeach)}
              />
              <Stat
                label={t("web.packageDetails.purchased")}
                value={dateFormatter.format(new Date(data.purchasedAt))}
              />
              <Stat
                label={t("web.packageDetails.expires")}
                value={
                  data.expiresAt
                    ? dateFormatter.format(new Date(data.expiresAt))
                    : t("web.packageDetails.noExpiry")
                }
              />
            </div>

            {data.counterpart && (
              <div className="flex items-center justify-between border-t pt-4 text-sm">
                <span className="text-muted-foreground">
                  {data.counterpart.role === "teacher"
                    ? t("web.packageDetails.teacher")
                    : t("web.packageDetails.student")}
                </span>
                {data.counterpart.role === "teacher" ? (
                  <Link
                    href={`/my-classes/teachers/${data.counterpart.id}`}
                    className="font-medium hover:underline"
                  >
                    {data.counterpart.name}
                  </Link>
                ) : (
                  <Link
                    href={`/dashboard/students/${data.counterpart.id}`}
                    className="font-medium hover:underline"
                  >
                    {data.counterpart.name}
                  </Link>
                )}
              </div>
            )}

            {data.price && (
              <div className="flex items-center justify-between border-t pt-4 text-sm">
                <span className="text-muted-foreground">{t("web.packageDetails.price")}</span>
                <span className="font-medium">
                  {formatMinorUnits(data.price.amountMinorUnits, data.price.currency)}
                </span>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
