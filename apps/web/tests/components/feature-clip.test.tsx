// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureClip } from "@/components/marketing/feature-clip";

function stubReducedMotion(matches: boolean) {
  const mql = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(el: React.ReactElement): Promise<HTMLVideoElement> {
  await act(async () => root.render(el));
  const video = container.querySelector("video");
  if (!video) throw new Error("no <video> rendered");
  return video;
}

describe("FeatureClip", () => {
  it("plays a muted, looping, inline clip from public/marketing with its poster and description", async () => {
    stubReducedMotion(false);
    const video = await mount(<FeatureClip name="booking" label="A student booking on a phone" />);
    expect(video.getAttribute("aria-label")).toBe("A student booking on a phone");
    expect(video.getAttribute("src")).toBe("/marketing/booking.mp4");
    expect(video.getAttribute("poster")).toBe("/marketing/booking.jpg");
    // The three attributes without which a browser will not autoplay, and
    // the one that keeps it from going full-screen on a phone.
    expect(video.muted).toBe(true);
    expect(video.hasAttribute("loop")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.hasAttribute("controls")).toBe(false);
  });

  it("gives a reader who asked for less motion the controls instead of autoplay", async () => {
    stubReducedMotion(true);
    const video = await mount(<FeatureClip name="call" label="A class with captions" />);
    expect(video.hasAttribute("controls")).toBe(true);
  });

  it("keeps a portrait clip to a phone's proportions", async () => {
    stubReducedMotion(false);
    const video = await mount(
      <FeatureClip name="vocabulary" label="Reviewing vocabulary" orientation="portrait" />,
    );
    expect(video.parentElement?.className).toContain("max-w-xs");
  });
});
