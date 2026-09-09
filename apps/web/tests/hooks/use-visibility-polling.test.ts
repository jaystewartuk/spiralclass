// @vitest-environment jsdom
//
// Regression coverage for the Realtime -> polling swap (student live-notes,
// call instructions overlay): both used to rely on Supabase Realtime
// `postgres_changes`, which only works against Supabase's own Postgres and
// became a hard blocker for moving the preview DB to a different provider
// (Neon) — see infra/database/neon/README.md. This hook is what replaced
// both subscriptions, so it's the one piece of that swap with meaningful
// control flow worth a dedicated test (the two call sites are themselves
// thin, untested-by-convention view wrappers, per this repo's coverage
// config — the plumbing lives here).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibilityPolling } from "@/hooks/use-visibility-polling";

function Probe({
  onTick,
  enabled,
  intervalMs,
}: {
  onTick: () => void;
  enabled: boolean;
  intervalMs?: number;
}) {
  useVisibilityPolling(onTick, { enabled, intervalMs });
  return null;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

describe("useVisibilityPolling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("ticks immediately on mount, then on each interval, while visible", () => {
    const onTick = vi.fn();
    act(() => {
      root.render(createElement(Probe, { onTick, enabled: true, intervalMs: 1000 }));
    });
    expect(onTick).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(onTick).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(2000));
    expect(onTick).toHaveBeenCalledTimes(4);
  });

  it("never ticks when disabled (mirrors windowOpen=false)", () => {
    const onTick = vi.fn();
    act(() => {
      root.render(createElement(Probe, { onTick, enabled: false, intervalMs: 1000 }));
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(onTick).not.toHaveBeenCalled();
  });

  it("stops polling when the tab is hidden and resumes with an immediate catch-up on visibility", () => {
    const onTick = vi.fn();
    act(() => {
      root.render(createElement(Probe, { onTick, enabled: true, intervalMs: 1000 }));
    });
    expect(onTick).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(onTick).toHaveBeenCalledTimes(1); // no ticks while hidden

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onTick).toHaveBeenCalledTimes(2); // immediate catch-up tick

    act(() => vi.advanceTimersByTime(1000));
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("ticks immediately on window focus, independent of the interval", () => {
    const onTick = vi.fn();
    act(() => {
      root.render(createElement(Probe, { onTick, enabled: true, intervalMs: 1000 }));
    });
    expect(onTick).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event("focus")));
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("stops all timers and listeners on unmount", () => {
    const onTick = vi.fn();
    act(() => {
      root.render(createElement(Probe, { onTick, enabled: true, intervalMs: 1000 }));
    });
    expect(onTick).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    act(() => vi.advanceTimersByTime(5000));
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});
