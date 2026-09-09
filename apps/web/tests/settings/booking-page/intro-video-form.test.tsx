// @vitest-environment jsdom
//
// IntroVideoForm — the teacher's recorder card. These pin the record-vs-upload
// EMPHASIS decision from the D-73 review, which is a product decision that
// a refactor could silently undo: recording in-app is the primary path (a warm
// phone selfie converts better than a produced marketing clip, and it is the
// only path with a known duration, orientation and length cap), while upload is
// demoted behind a disclosure — but deliberately NOT removed, because deleting
// it would strand a teacher whose browser blocks the camera.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const capture = vi.fn();
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture }) }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

vi.mock("@/app/actions/profile", () => ({
  presignIntroVideoUploadAction: vi.fn(),
  finalizeIntroVideoAction: vi.fn(),
  removeIntroVideoAction: vi.fn(),
}));

// The coach panel has its own suite; stub it so this file is only about the
// recorder's own layout.
vi.mock("@/app/(app)/settings/booking-page/intro-video-coach-panel", () => ({
  IntroVideoCoachPanel: () => null,
}));

const { IntroVideoForm } = await import("@/app/(app)/settings/booking-page/intro-video-form");

const ANALYSIS = { status: null, coach: null, error: null };

describe("IntroVideoForm — record/upload hierarchy", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalMediaDevices = (globalThis.navigator as { mediaDevices?: unknown }).mediaDevices;

  beforeEach(() => {
    capture.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // The camera-denial test below replaces navigator.mediaDevices. Restore it
    // so nothing that runs afterwards inherits a permanently-denied camera —
    // vitest isolates per file, but an un-restored global mutation is exactly
    // the kind of thing that turns into a load-dependent phantom failure.
    if (originalMediaDevices === undefined) {
      delete (globalThis.navigator as { mediaDevices?: unknown }).mediaDevices;
    } else {
      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices,
      });
    }
  });

  function render(videoUrl: string | null = null) {
    act(() => {
      root.render(React.createElement(IntroVideoForm, { videoUrl, analysis: ANALYSIS }));
    });
  }

  const byText = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));

  it("collapses the file input behind a disclosure so there is one obvious action", () => {
    render();
    // The whole point of the demotion: no second file input + second CTA
    // competing with the record button on first paint.
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(byText("web.settings.bookingPage.video.haveVideoAlready")).toBeTruthy();
    expect(byText("bookingPage.recordVideo")).toBeTruthy();
  });

  it("reveals the file input when the disclosure is clicked", () => {
    render();
    act(() => {
      byText("web.settings.bookingPage.video.haveVideoAlready")?.click();
    });
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("reports the disclosure click as upload INTENT", () => {
    // `teacher_intro_video_set` only fires for uploads that succeed, so it
    // can't answer "how many teachers even considered uploading" — which is the
    // input to whether this path should exist at all.
    render();
    act(() => {
      byText("web.settings.bookingPage.video.haveVideoAlready")?.click();
    });
    expect(capture).toHaveBeenCalledWith(
      "intro_video_upload_revealed",
      expect.objectContaining({ surface: "web" }),
    );
  });

  it("force-reveals upload when the camera fails, so a denial is not a dead end", async () => {
    // The reason upload survives at all. A teacher who denies the camera
    // permission (or has no camera) must not be left with a red error and no
    // route forward.
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          const err = new Error("denied");
          err.name = "NotAllowedError";
          throw err;
        }),
      },
    });

    render();
    expect(container.querySelector('input[type="file"]')).toBeNull();

    await act(async () => {
      byText("bookingPage.recordVideo")?.click();
      await Promise.resolve();
    });

    expect(capture).toHaveBeenCalledWith(
      "intro_video_recording_failed",
      expect.objectContaining({ reason: "NotAllowedError" }),
    );
    // Revealed WITHOUT the teacher having to find the disclosure herself.
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });
});
