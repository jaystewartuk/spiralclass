"use client";

import { useCallSession } from "@/lib/video/call-session-context";
import { ClassCallClient } from "./class-call-client";

// Rendered exactly once, from app/layout.tsx — a root-level layout Next.js
// keeps mounted across every client-side navigation, which is the whole
// point: as long as `session` is set, <ClassCall> stays mounted (and
// connected) regardless of which page is currently showing underneath it.
// Renders nothing when there's no active call.
export function CallSessionOverlay() {
  const { session, endCall } = useCallSession();
  if (!session) return null;
  return <ClassCallClient {...session} onLeave={endCall} />;
}
