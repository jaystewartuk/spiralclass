"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";
import type { StringKey } from "@/lib/i18n-translate";

type Step = { href: string; labelKey: StringKey };

const STEPS: Step[] = [
  // Reading comes first: every step after it is easier to read once it is set.
  { href: "/onboarding/reading", labelKey: "web.onboarding.stepper.reading" },
  { href: "/onboarding/timezone", labelKey: "web.onboarding.stepper.timezone" },
  { href: "/onboarding/availability", labelKey: "web.onboarding.stepper.availability" },
  { href: "/onboarding/templates", labelKey: "web.onboarding.stepper.packages" },
  { href: "/onboarding/preview", labelKey: "web.onboarding.stepper.link" },
];

export function OnboardingBack() {
  const pathname = usePathname();
  const t = useT();
  const activeIndex = STEPS.findIndex((s) => pathname?.startsWith(s.href));
  if (activeIndex <= 0) return null;
  const previous = STEPS[activeIndex - 1];
  const previousLabel = t(previous.labelKey).toLowerCase();
  return (
    <Link
      href={previous.href}
      className="text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1 text-sm"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {t("web.onboarding.stepper.backTo", { step: previousLabel })}
    </Link>
  );
}

export function OnboardingStepper() {
  const pathname = usePathname();
  const t = useT();
  const activeIndex = STEPS.findIndex((s) => pathname?.startsWith(s.href));

  return (
    <nav aria-label={t("web.onboarding.stepper.progress")} className="mb-8">
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {STEPS.map((s, i) => {
          const isActive = i === activeIndex;
          const isComplete = activeIndex > -1 && i < activeIndex;
          return (
            <li key={s.href} className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium",
                  isActive && "border-primary bg-primary text-primary-foreground",
                  isComplete && "border-primary/40 bg-primary/15 text-primary",
                  !isActive && !isComplete && "border-border bg-muted text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <Link
                href={s.href}
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "font-medium hover:underline",
                  isActive && "text-foreground",
                  !isActive && "text-muted-foreground",
                )}
              >
                {t(s.labelKey)}
              </Link>
              {i < STEPS.length - 1 && (
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
