"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

export function CopyLinkButton({
  value,
  label,
  ariaLabel,
  toastMessage,
  iconOnly = false,
  className,
}: {
  value: string;
  label?: string;
  /**
   * Overrides the accessible name where the visible one repeats down a list —
   * six rows of "Copy link" are six identical buttons to a screen-reader user.
   * Must CONTAIN the visible label (WCAG 2.5.3), e.g. "Copy the checkout link
   * for SUMMER25".
   */
  ariaLabel?: string;
  toastMessage?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const resolvedLabel = label ?? t("common.copy");
  const resolvedToast = toastMessage ?? t("web.copyLinkButton.linkCopied");

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(resolvedToast);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("web.copyLinkButton.copyFailed"));
    }
  };

  if (iconOnly) {
    // A real <Button>, not a bare <button> with `p-1`. The hand-rolled version
    // was a 24px target in a product whose standing minimum is 44 (D-140), and
    // it had no focus ring — the two things the primitive exists to guarantee.
    //
    // The accessible name is the CALLER's label when there is one. It was
    // hardcoded to "Copy link" here, so the copy control next to a teacher's
    // email address announced itself as copying a link.
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClick}
        aria-label={ariaLabel ?? label ?? t("web.copyLinkButton.copyLink")}
        className={cn("text-muted-foreground hover:text-foreground shrink-0", className)}
      >
        {copied ? (
          <Check className="text-success h-4 w-4" aria-hidden />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={ariaLabel}
      className={className}
    >
      {copied ? (
        <>
          <Check className="mr-2 h-4 w-4" aria-hidden /> {t("common.copied")}
        </>
      ) : (
        <>
          <Copy className="mr-2 h-4 w-4" aria-hidden /> {resolvedLabel}
        </>
      )}
    </Button>
  );
}
