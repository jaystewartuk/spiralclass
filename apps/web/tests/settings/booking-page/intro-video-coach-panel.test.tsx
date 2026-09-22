import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// AI Coach panel (D-73, Layer 3) — one render per pipeline status, checking
// each state shows the right affordance: a processing indicator while
// pending/transcribing, a retry button on failure, the structured feedback on
// success, and nothing at all when no analysis has ever run.

vi.mock("@/app/actions/profile", () => ({
  getIntroVideoAnalysisStateAction: vi.fn(),
  retryIntroVideoAnalysisAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("posthog-js/react", () => ({ usePostHog: () => null }));

const { IntroVideoCoachPanel } =
  await import("@/app/(app)/settings/booking-page/intro-video-coach-panel");

function render(initial: {
  status: "pending" | "transcribing" | "transcribed" | "failed" | null;
  coach: { overall: string; strengths: string[]; improvements: string[] } | null;
  error: string | null;
}) {
  return renderToStaticMarkup(
    React.createElement(IntroVideoCoachPanel, { initial, hidden: false }),
  );
}

describe("IntroVideoCoachPanel", () => {
  it("renders nothing when no analysis has ever run", () => {
    const html = render({ status: null, coach: null, error: null });
    expect(html).toBe("");
  });

  it("renders nothing while hidden, even mid-analysis", () => {
    const html = renderToStaticMarkup(
      React.createElement(IntroVideoCoachPanel, {
        initial: { status: "transcribing", coach: null, error: null },
        hidden: true,
      }),
    );
    expect(html).toBe("");
  });

  it("shows a processing indicator while pending", () => {
    const html = render({ status: "pending", coach: null, error: null });
    expect(html).toContain("web.settings.bookingPage.video.coachProcessingTitle");
    expect(html).toContain("animate-spin");
  });

  it("shows a processing indicator while transcribing", () => {
    const html = render({ status: "transcribing", coach: null, error: null });
    expect(html).toContain("web.settings.bookingPage.video.coachProcessingTitle");
  });

  it("shows a retry affordance on failure", () => {
    const html = render({ status: "failed", coach: null, error: "transcription-failed" });
    expect(html).toContain("web.settings.bookingPage.video.coachFailedTitle");
    expect(html).toContain("transcription-failed");
    expect(html).toContain("web.settings.bookingPage.video.coachRetry");
  });

  it("shows the structured coach feedback on success", () => {
    const html = render({
      status: "transcribed",
      coach: {
        overall: "Great energy!",
        strengths: ["Clear pitch"],
        improvements: ["Mention pricing"],
      },
      error: null,
    });
    expect(html).toContain("Great energy!");
    expect(html).toContain("Clear pitch");
    expect(html).toContain("Mention pricing");
    expect(html).toContain("web.settings.bookingPage.video.coachTitle");
  });
});
