"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useT } from "@/components/locale-provider";

// Proactive gating note for a Pro-only control that stays VISIBLE (never
// hidden — a Free teacher should discover the feature exists) but disabled,
// with an explanation and an upgrade path right next to it. Pairs with
// disabling the triggering control itself (`disabled={!isPro}`) — this
// component only supplies the "why" + "how to fix it" text, never the gate
// itself, so it can't drift from the actual `disabled` condition it explains.
export function ProLockNote({ message }: { message: string }) {
  const t = useT();
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
      <Lock className="size-3.5 shrink-0" aria-hidden />
      <span>{message}</span>
      <Link
        href="/settings/billing"
        className="text-primary font-medium underline underline-offset-2"
      >
        {t("settings.billing.upgrade")}
      </Link>
    </p>
  );
}
