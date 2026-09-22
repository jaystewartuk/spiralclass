"use client";

import { useEffect } from "react";

// Portable near-real-time refresh (no Supabase Realtime — keeps the DB
// portable, D-49/D-44): fast-poll `onTick` while the tab is visible, and
// fire it instantly whenever the tab regains visibility/focus. Polling
// pauses while hidden so we don't hammer the server in the background.
// Mirrors chat-room.tsx's polling pattern (the original portable-realtime
// implementation this hook generalizes).
export function useVisibilityPolling(
  onTick: () => void,
  { enabled = true, intervalMs = 4_000 }: { enabled?: boolean; intervalMs?: number } = {},
) {
  useEffect(() => {
    if (!enabled) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      onTick();
      interval = setInterval(onTick, intervalMs);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onTick);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onTick);
    };
  }, [enabled, intervalMs, onTick]);
}
