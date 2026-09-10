"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/components/locale-provider";
import { AccountAvatar } from "@/components/account-avatar";
import { cn } from "@/lib/utils";

// "Which account am I signed in as?" — one shared indicator for every
// authenticated header (teacher, student, admin, onboarding). Shows an
// initials avatar plus the account's display name, with the email surfaced
// on hover/focus. Keeping it in one place means the answer looks and reads
// the same on every page instead of each shell hand-rolling its own.
//
//   variant="compact"  header chrome: avatar + name, email in a tooltip.
//   variant="full"     stacked avatar + name over email (mobile menus,
//                       focused layouts) — no tooltip, both lines visible.
//
// Both `name` and `email` are optional: admins carry only an email (it
// becomes the label), and booking-link students may have a name but no
// email yet (the tooltip/second line is simply omitted).
export function AccountBadge({
  name,
  email,
  photoUrl,
  variant = "compact",
  nameClassName,
  className,
}: {
  name?: string | null;
  email?: string | null;
  // Version-stamped profile photo URL; null/absent → initials monogram.
  photoUrl?: string | null;
  variant?: "compact" | "full";
  // Lets a crowded header hide the name at narrow widths (e.g. "hidden
  // xl:block") while the avatar + tooltip still identify the account.
  nameClassName?: string;
  className?: string;
}) {
  const t = useT();
  const cleanName = name?.trim() || "";
  const cleanEmail = email?.trim() || "";
  const fallback = t("web.accountBadge.fallback");
  const label = cleanName || cleanEmail || fallback;
  // A distinct email line only makes sense when there's also a name to
  // distinguish it from — otherwise the email is already the label.
  const aside = cleanName && cleanEmail ? cleanEmail : "";
  const signedInAs = t("web.accountBadge.signedInAs");

  const avatar = (
    <AccountAvatar
      name={name}
      email={email}
      photoUrl={photoUrl}
      size={variant === "full" ? "lg" : "sm"}
    />
  );

  if (variant === "full") {
    return (
      <div className={cn("flex items-center gap-3", className)}>
        {avatar}
        <span className="flex min-w-0 flex-col">
          <span className="text-foreground truncate text-sm font-medium">{label}</span>
          {aside && <span className="text-muted-foreground truncate text-xs">{aside}</span>}
        </span>
      </div>
    );
  }

  const chip = (
    <button
      type="button"
      // Purely an info reveal — the label already names the account, so
      // there's no action to take. cursor-default signals that.
      className={cn(
        "text-foreground focus-visible:ring-ring inline-flex max-w-64 cursor-default items-center gap-2 rounded-full py-0.5 pr-2 pl-0.5 text-sm focus-visible:ring-3 focus-visible:outline-hidden",
        className,
      )}
      aria-label={`${signedInAs} ${label}${aside ? ` (${aside})` : ""}`}
    >
      {avatar}
      <span className={cn("truncate", nameClassName)}>{label}</span>
    </button>
  );

  // Nothing extra to reveal when the email is already the visible label.
  if (!aside) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="bottom">{aside}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
