"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import {
  type GrowthChecklist as GrowthChecklistData,
  type ResolvedGrowthStep,
  type ShareChannel,
  growthAllDoneLabel,
  growthProgressLabel,
  growthSubtitle,
  growthTitle,
  shareChannelLabel,
  shareText,
  shareTaggedUrl,
} from "@spiralclass/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { webNavHref } from "@/lib/nav";
import type { AppLocale } from "@/lib/i18n";

// The "Crecer" / "Grow" card on the teacher dashboard — the in-app
// teacher-amplification guide (D-24 / STUDENT_ACQUISITION.md). The ordered
// steps + their done-state come pre-resolved from the shared `growthSteps`
// model; this component is a dumb bilingual renderer that wires each CTA to
// the feature that executes it and fires a funnel event when a step is acted
// on (autocapture covers the click, the named event keeps the funnel legible).
export function GrowthChecklist({
  checklist,
  bookingUrl,
  locale,
}: {
  checklist: GrowthChecklistData;
  bookingUrl: string;
  locale: AppLocale;
}) {
  const posthog = usePostHog();
  const t = useT();
  // Which Facebook CTA just copied its post — drives the brief "Copied" label
  // (the assisted flow is copy-then-paste-into-your-group, so confirm the copy).
  const [copied, setCopied] = useState(false);

  const track = (step: ResolvedGrowthStep, channel?: ShareChannel) =>
    posthog?.capture("growth_step_action", {
      step: step.key,
      done: step.done,
      surface: "web",
      ...(channel ? { channel } : {}),
    });

  const onShare = async (step: ResolvedGrowthStep, channel: ShareChannel) => {
    track(step, channel);
    const text = shareText(bookingUrl, channel, locale);
    if (channel === "whatsapp") {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
      return;
    }
    // Facebook: there's no API to post into a group, so hand the teacher the
    // ready-to-paste post (copied) and open Facebook's groups feed for them to
    // pick a group and paste. Falls back to opening the share dialog if the
    // clipboard is unavailable.
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
      window.open("https://www.facebook.com/groups/feed/", "_blank", "noopener");
    } catch {
      window.open(
        `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
          shareTaggedUrl(bookingUrl, channel),
        )}`,
        "_blank",
        "noopener",
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          {/* h2: every section on the dashboard sits directly under the page
              h1 (the greeting), so the outline has no h3 to hang this off. */}
          <CardTitle className="text-lg" as="h2">
            {growthTitle(locale)}
          </CardTitle>
          <span className="text-sm font-medium text-muted-foreground tabular-nums">
            {growthProgressLabel(checklist.doneCount, checklist.total, locale)}
          </span>
        </div>
        <CardDescription>
          {checklist.complete ? growthAllDoneLabel(locale) : growthSubtitle(locale)}
        </CardDescription>
        {/* A single visible percentage is
            the "reward before the ask" signal (Airbnb/Shopify-style launch
            checklists) that pulls a teacher back to finish, beyond a bare
            item list. */}
        <div
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={t("web.growthChecklist.progressLabel")}
          aria-valuenow={checklist.percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${checklist.percent}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {checklist.steps.map((step) => (
          <div key={step.key} className="flex items-start gap-3">
            {step.done ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
            ) : (
              <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground/50" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`font-medium ${step.done ? "text-muted-foreground" : ""}`}>
                  {step.title}
                </span>
                {step.count ? (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                    {step.count}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">{step.body}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {step.action.kind === "share" ? (
                  step.action.channels.map((channel) => (
                    <Button
                      key={channel}
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onShare(step, channel)}
                    >
                      {channel === "facebook" && copied
                        ? t("web.growthChecklist.copiedPasteInGroup")
                        : shareChannelLabel(channel, locale)}
                    </Button>
                  ))
                ) : (
                  // A done step's CTA was `ghost`, which on a card has no border
                  // and no fill — it rendered as a line of plain text sitting at
                  // a button's left padding, so it read as broken indentation
                  // rather than as a control. An underlined muted link says
                  // "still reachable, nothing to do here" and aligns with the
                  // copy above it.
                  //
                  // NOT the `link` variant, which is `text-primary`: that token
                  // measures 3.48:1 as text on a raised card in dark mode (it is
                  // verified only as a button fill — see the note in
                  // dashboard-view.tsx), and axe caught it here.
                  <Button
                    asChild
                    variant={step.done ? "ghost" : "outline"}
                    size="sm"
                    className={
                      step.done
                        ? "px-0 text-muted-foreground underline underline-offset-4 hover:bg-transparent"
                        : undefined
                    }
                  >
                    <Link href={webNavHref(step.action.nav)} onClick={() => track(step)}>
                      {step.ctaLabel}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
