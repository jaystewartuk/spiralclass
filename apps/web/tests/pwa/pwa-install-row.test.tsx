// @vitest-environment jsdom
//
// What the install row shows, and — mostly — when it shows nothing.
//
// The restraint is the design, so it is the thing pinned here. There is no
// native app, so installing the PWA IS the app; but the row appears
// only where there is a real one-tap install to offer, because the two other
// cases are already better served elsewhere or cannot be served at all:
//
//   - iOS never fires `beforeinstallprompt`, and Web Push does not exist there
//     until the site is on the Home Screen — so WebPushToggle's
//     `ios-needs-install` state carries those instructions, beside the control
//     they unblock.
//   - Firefox and desktop Safari cannot install. Steps nobody can follow are
//     worse than nothing.
//
// No @testing-library/react in this repo — see
// tests/components/report-problem-dialog.test.tsx for the raw
// createRoot + act() pattern this follows.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Echo the catalog KEY, so these assertions pin structure and wiring rather
// than copy.
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { PwaInstallRow } = await import("@/components/account/pwa-install-row");
const { captureInstallPromptForTests, resetInstallPromptForTests, startCapturingInstallPrompt } =
  await import("@/lib/pwa/install-prompt");

type PromptEvent = import("@/lib/pwa/install-prompt").BeforeInstallPromptEvent;

function fakeEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn(async () => undefined);
  return {
    event: { prompt, userChoice: Promise.resolve({ outcome }) } as unknown as PromptEvent,
    prompt,
  };
}

describe("PwaInstallRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Not standalone: the ordinary tab every case below starts from.
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetInstallPromptForTests();
    vi.restoreAllMocks();
  });

  const render = () =>
    act(() => {
      root.render(<PwaInstallRow />);
    });

  it("shows nothing on a browser that never offered an install", () => {
    render();
    // Firefox, desktop Safari, and iOS — where the instructions live with the
    // push toggle instead.
    expect(container.textContent).toBe("");
  });

  it("appears once the browser offers one, without a remount", () => {
    render();
    expect(container.textContent).toBe("");
    // The event arrives after the component is already on screen, which is the
    // ordinary case: Chrome fires it on its own schedule.
    act(() => captureInstallPromptForTests(fakeEvent().event));
    expect(container.textContent).toContain("web.pwaInstall.title");
    expect(container.querySelector("button")?.textContent).toBe("web.pwaInstall.action");
  });

  it("shows nothing when already running as an installed app", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    act(() => captureInstallPromptForTests(fakeEvent().event));
    render();
    // Chrome can still fire the event in some standalone contexts; offering an
    // install to someone who has already installed is the bug this prevents.
    expect(container.textContent).toBe("");
  });

  it("prompts the browser when the button is pressed", async () => {
    const { event, prompt } = fakeEvent();
    act(() => captureInstallPromptForTests(event));
    render();
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("goes away after a dismissal rather than offering a spent event", async () => {
    act(() => captureInstallPromptForTests(fakeEvent("dismissed").event));
    render();
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // A dismissal is a decision, not a failure — nothing is said about it, and
    // the single-use event is gone either way.
    expect(container.textContent).toBe("");
  });

  it("says so, in words, once the app is installed", async () => {
    startCapturingInstallPrompt();
    act(() => captureInstallPromptForTests(fakeEvent().event));
    render();
    await act(async () => {
      // Fired by the browser whichever route the install took — our button or
      // its own menu.
      window.dispatchEvent(new Event("appinstalled"));
    });
    // A control that simply vanishes reads as a rendering bug rather than as
    // the thing having worked (D-140: status is never carried by absence).
    expect(container.textContent).toContain("web.pwaInstall.badge.installed");
    expect(container.textContent).toContain("web.pwaInstall.installedHelp");
    expect(container.querySelector("button")).toBeNull();
  });
});
