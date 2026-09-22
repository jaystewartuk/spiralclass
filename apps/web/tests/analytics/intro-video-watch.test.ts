// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { markIntroVideoWatched, readIntroVideoWatch } from "@/lib/analytics/intro-video-watch";

// The bridge that lets `checkout_submitted` be split by "did this buyer watch
// the intro?" — the single question that decides whether the intro-video
// feature earns its keep. It has to survive the /b/<slug> → /b/<slug>/buy
// navigation, and it must never break a booking page when storage is
// unavailable (Safari private mode, storage disabled, an embedded webview).

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("intro-video watch mark", () => {
  it("reports the control group (never played) as watched:false, not missing data", () => {
    expect(readIntroVideoWatch("alicia-moreno")).toEqual({ watched: false, maxPercent: 0 });
  });

  it("survives a navigation, which is the entire point", () => {
    markIntroVideoWatched("alicia-moreno", 40);
    // A fresh read is exactly what the checkout page does after the client-side
    // route change — no shared React state involved.
    expect(readIntroVideoWatch("alicia-moreno")).toEqual({ watched: true, maxPercent: 40 });
  });

  it("counts a play with zero progress as watched", () => {
    // First play marks 0% — the visitor DID press play, which is the cohort
    // split we care about, even if they bailed immediately.
    markIntroVideoWatched("alicia-moreno", 0);
    expect(readIntroVideoWatch("alicia-moreno").watched).toBe(true);
  });

  it("is monotonic — a replay that stops early never erases a full watch", () => {
    markIntroVideoWatched("alicia-moreno", 100);
    markIntroVideoWatched("alicia-moreno", 12);
    expect(readIntroVideoWatch("alicia-moreno").maxPercent).toBe(100);
  });

  it("keeps two teachers' marks apart", () => {
    // A visitor comparing teachers must not have one teacher's watch credited
    // to the other's checkout.
    markIntroVideoWatched("alicia-moreno", 80);
    expect(readIntroVideoWatch("otro-profe")).toEqual({ watched: false, maxPercent: 0 });
  });

  it("never throws when sessionStorage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => markIntroVideoWatched("alicia-moreno", 50)).not.toThrow();
    spy.mockRestore();

    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readIntroVideoWatch("alicia-moreno")).toEqual({ watched: false, maxPercent: 0 });
    getSpy.mockRestore();
  });

  it("treats a corrupted stored value as watched with unknown progress", () => {
    window.sessionStorage.setItem("ap.introVideoWatched.alicia-moreno", "not-a-number");
    expect(readIntroVideoWatch("alicia-moreno")).toEqual({ watched: true, maxPercent: 0 });
  });
});
