// @vitest-environment jsdom
//
// The intro video's preload upgrade, and the abort that makes it safe to have.
//
// History worth keeping, because this has been shipped and reverted once: the
// upgrade existed, was reverted on 2026-08-30 because the teacher's file was a
// 42 MB non-faststart MP4 (no frame decodable until the whole thing arrived),
// and is back on 2026-08-31 because that file is gone — the live one is 6.3 MB
// with `moov` at byte 32.
//
// Nothing validates faststart at upload and MAX_VIDEO_BYTES is 50 MB, so the
// next upload could recreate the bad case. The abort is what stops that being a
// regression instead of a slow frame, and it is the reason this file exists: a
// non-faststart file cannot decode a frame quickly BY CONSTRUCTION, so "no
// frame within ABORT_MS" is a reliable proxy for "this file is the bad shape",
// without a cross-origin HEAD to measure its size.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock("@/lib/analytics/intro-video-watch", () => ({
  markIntroVideoWatched: vi.fn(),
  readIntroVideoWatch: () => ({ watched: false, maxPercent: 0 }),
  introVideoWatchSummary: () => ({}),
}));

// Captures the observer callback so a test can say "the card is on screen now".
let fireIntersection: ((entries: unknown[]) => void) | null = null;
class FakeObserver {
  constructor(cb: (entries: unknown[]) => void) {
    fireIntersection = cb;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

const { IntroVideoCard } = await import("@/app/b/[slug]/intro-video-card");

describe("IntroVideoCard — preload upgrade and its abort", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    fireIntersection = null;
    (globalThis as Record<string, unknown>).IntersectionObserver = FakeObserver;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(IntroVideoCard, {
          videoUrl: "https://cdn.test/intro.mp4",
          teacherName: "Alicia Moreno",
          teacherId: "t1",
          slug: "alicia-moreno",
        }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const video = () => container.querySelector("video")!;
  const scrollIntoView = () =>
    act(() => {
      fireIntersection?.([{ isIntersecting: true }]);
    });

  it("starts at metadata, so a visitor who never scrolls here pays nothing", () => {
    expect(video().preload).toBe("metadata");
  });

  it("upgrades to auto once the card is actually on screen", () => {
    scrollIntoView();
    expect(video().preload).toBe("auto");
  });

  it("gives up when no frame arrives, rather than pulling tens of megabytes", () => {
    scrollIntoView();
    expect(video().preload).toBe("auto");

    // readyState stays 0 — exactly what a non-faststart file does, because the
    // index is at the end and nothing is decodable until the file lands.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(video().preload).toBe("none");
  });

  it("keeps the upgrade when a frame does arrive in time", () => {
    scrollIntoView();
    const el = video();
    Object.defineProperty(el, "readyState", { value: 2, configurable: true });
    act(() => {
      el.dispatchEvent(new Event("loadeddata"));
      vi.advanceTimersByTime(5000);
    });
    expect(el.preload).toBe("auto");
  });

  it("does not upgrade at all when the visitor asked us to save data", () => {
    act(() => root.unmount());
    (navigator as Navigator & { connection?: unknown }).connection = { saveData: true };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(IntroVideoCard, {
          videoUrl: "https://cdn.test/intro.mp4",
          teacherName: "Alicia Moreno",
          teacherId: "t1",
          slug: "alicia-moreno",
        }),
      );
    });
    scrollIntoView();
    expect(video().preload).toBe("metadata");
    delete (navigator as Navigator & { connection?: unknown }).connection;
  });
});
