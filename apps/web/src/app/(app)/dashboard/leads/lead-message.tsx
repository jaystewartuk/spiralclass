"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

/**
 * What the person actually wrote — the only part of a row that is theirs.
 *
 * Set on the mid surface so it reads as a quotation rather than as more of the
 * app's own chrome, and clamped past a couple of paragraphs: the capture form
 * accepts a thousand characters, which is fifteen lines, and one talkative
 * enquiry unclamped pushes every other row on the screen below the fold.
 *
 * A CLIENT TOGGLE RATHER THAN A `<details>`, which is the opposite of what
 * this codebase usually reaches for and is a measured decision. The native
 * disclosure would need the summary rendered BELOW the text it expands, and
 * the only way to do that is `display: flex` on the `<details>` itself — which
 * is measurably broken: in Chromium 141 a flexed `<details>` shows its content
 * while closed, because the UA's own hiding depends on the element's default
 * display. Verified in the browser before writing this, not assumed. So the
 * control is a real button with `aria-expanded` and `aria-controls`, which is
 * what a native `<summary>` compiles down to in the accessibility tree anyway.
 *
 * WHETHER TO OFFER IT AT ALL is decided from the character count rather than
 * from measuring the rendered height, because the height is not known on the
 * server and a toggle that appears after hydration is a layout shift on every
 * row. The threshold is set where four lines of this column run out, so a
 * message that is not actually clipped almost never gets a pointless control.
 */
const CLAMP_CHARS = 240;

export function LeadMessage({ message }: { message: string }) {
  const t = useT();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const clampable = message.length > CLAMP_CHARS;

  return (
    <div className="rounded-md bg-muted/40 p-3 text-sm">
      <p id={id} className={cn("whitespace-pre-line", clampable && !expanded && "line-clamp-4")}>
        {message}
      </p>
      {clampable && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
          className="-ml-3 mt-1 h-auto px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("size-3", expanded && "rotate-180")} aria-hidden />
          {expanded
            ? t("web.dashboard.leads.showLessMessage")
            : t("web.dashboard.leads.showFullMessage")}
        </Button>
      )}
    </div>
  );
}
