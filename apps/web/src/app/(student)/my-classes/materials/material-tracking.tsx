"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

// Client-side leaves for the otherwise server-rendered materials page
// (page.tsx) — firing material_opened/material_completed needs a browser
// event (click / details-toggle / audio-ended), which a Server Component
// can't observe. Each POST hits the small purpose-built route under
// api/materials/[id]/**, which does the actual (ad-blocker-resistant)
// server-side PostHog capture — these components are just the trigger.
//
// They carry no appearance of their own: every one takes a `className` so the
// page owns how a material row looks. A component that both tracks an event
// and hardcodes its own border is a component the page cannot restyle.

function postOpened(materialId: string) {
  fetch(`/api/materials/${materialId}/opened`, { method: "POST", keepalive: true }).catch(() => {});
}

function postCompleted(materialId: string, durationSeconds?: number) {
  fetch(`/api/materials/${materialId}/completed`, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ durationSeconds }),
  }).catch(() => {});
}

export function MaterialOpenLink({
  materialId,
  href,
  className,
  children,
}: {
  materialId: string;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      onClick={() => postOpened(materialId)}
    >
      {children}
    </a>
  );
}

// Wraps a native-content material's <details> — expanding it is the
// "opening" action for content that renders inline instead of navigating.
// Fires once per mount (a student re-collapsing/re-expanding out of
// curiosity shouldn't inflate the count).
export function MaterialDetails({
  materialId,
  className,
  summary,
  children,
}: {
  materialId: string;
  className?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const fired = useRef(false);
  return (
    <details
      className={className}
      onToggle={(e) => {
        if (fired.current || !e.currentTarget.open) return;
        fired.current = true;
        postOpened(materialId);
      }}
    >
      {summary}
      {children}
    </details>
  );
}

export function MaterialPodcastPlayer({
  materialId,
  src,
  durationSeconds,
  className,
}: {
  materialId: string;
  src: string;
  durationSeconds?: number | null;
  className?: string;
}) {
  return (
    <audio
      controls
      src={src}
      className={cn("w-full", className)}
      preload="none"
      onEnded={() => postCompleted(materialId, durationSeconds ?? undefined)}
    >
      <track kind="captions" />
    </audio>
  );
}
