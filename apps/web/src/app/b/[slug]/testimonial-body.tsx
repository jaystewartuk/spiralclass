"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A published testimonial's words on the public booking page, clamped past the
 * height of a card.
 *
 * WHY THIS EXISTS. The body cap was raised from 600 to 1200 characters in
 * 2026-09, because a teacher's real testimonials did not fit — and the card
 * rendered whatever it was given, unclamped, inside a `grid` whose siblings
 * carry `h-full`. One long quote therefore set the height of its whole row and
 * left the short ones standing in whitespace. Raising the cap without this is
 * a visible regression on the page the product exists to sell from.
 *
 * A CLIENT TOGGLE RATHER THAN A `<details>`, for the reason `LeadMessage`
 * already measured and wrote down: a native disclosure needs its `<summary>`
 * rendered BELOW the text it expands, the only way to reorder that is
 * `display: flex` on the `<details>`, and a flexed `<details>` shows its
 * content while closed in Chromium 141. This is the same shape as that
 * component deliberately — one pattern for "clamped prose with a toggle",
 * not two.
 *
 * LABELS ARE PROPS, not `useT()`. This page resolves its strings through
 * `getPublicFunnelT(funnelLocale)` — the visitor's funnel locale, which is not
 * the signed-in app locale the client provider carries. Passing the resolved
 * strings down keeps one locale decision on the page that already made it.
 *
 * WHETHER TO OFFER THE TOGGLE is decided from the character count, not from
 * measuring the rendered height: the height is not known on the server, and a
 * control that appears after hydration is a layout shift in every card. The
 * threshold is where five lines of a half-width card run out.
 */
const CLAMP_CHARS = 320;

export function TestimonialBody({
  body,
  moreLabel,
  lessLabel,
}: {
  body: string;
  moreLabel: string;
  lessLabel: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const clampable = body.length > CLAMP_CHARS;

  return (
    <>
      <p
        id={id}
        className={cn(
          "text-sm whitespace-pre-line text-foreground/80",
          clampable && !expanded && "line-clamp-5",
        )}
      >
        {body}
      </p>
      {clampable && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
          className="-ml-3 h-auto px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("size-3", expanded && "rotate-180")} aria-hidden />
          {expanded ? lessLabel : moreLabel}
        </Button>
      )}
    </>
  );
}
