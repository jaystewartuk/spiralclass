"use client";

import type { LucideIcon } from "lucide-react";
import { NavRowIcon, NavRowLabel, type NavRowDensity } from "@/components/nav/nav-row";
import { getSupportContext } from "@/lib/analytics/posthog-browser";
import { supportWhatsAppUrl } from "@/lib/support";

// Opens the WhatsApp support deep-link pre-filled with the caller's PostHog
// distinct ID, current page URL, and session replay link — so the developer
// can watch exactly what the user was doing without having to ask. Renders
// nothing when NEXT_PUBLIC_SUPPORT_WHATSAPP is not configured.
export function WhatsAppSupportButton({
  label,
  className,
  icon: Icon,
  density,
}: {
  label: string;
  className?: string;
  // See ReportProblemButton — the same nav-row alignment and density.
  icon?: LucideIcon;
  density?: NavRowDensity;
}) {
  function handleClick() {
    const { distinctId, replayUrl } = getSupportContext();
    const url = supportWhatsAppUrl({
      page: typeof window !== "undefined" ? window.location.href : undefined,
      userId: distinctId,
      replayUrl,
    });
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <button type="button" onClick={handleClick} className={className}>
      <NavRowIcon icon={Icon} density={density} />
      <NavRowLabel>{label}</NavRowLabel>
    </button>
  );
}
