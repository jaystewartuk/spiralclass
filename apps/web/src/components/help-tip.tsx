"use client";

import Link from "next/link";
import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// In-app inline help. Renders a small `?` icon that reveals a short
// explanation on hover (desktop) or tap (mobile). Keep `text` to one
// short sentence — anything longer belongs behind `learnMoreHref`, a deep
// link into the centralized help docs (@spiralclass/shared content registry,
// rendered at /help/[audience]/[slug]).
//
// `aria-label` is required so screen readers announce the tooltip
// trigger (the icon alone is decorative).
export function HelpTip({
  text,
  label,
  learnMoreHref,
  learnMoreLabel,
}: {
  text: string;
  label: string;
  learnMoreHref?: string;
  learnMoreLabel?: string;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="space-y-1">
          <p>{text}</p>
          {learnMoreHref && (
            <Link href={learnMoreHref} className="block underline underline-offset-2">
              {learnMoreLabel}
            </Link>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
