// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureInstallPromptForTests,
  hasInstallPrompt,
  isRunningStandalone,
  onInstallPromptChange,
  promptInstall,
  resetInstallPromptForTests,
  startCapturingInstallPrompt,
  wasInstalled,
  type BeforeInstallPromptEvent,
} from "./install-prompt";

/**
 * The store that holds `beforeinstallprompt`.
 *
 * WHY IT IS A STORE. Chrome fires the event once, early, and a listener
 * registered later gets nothing — so a component that starts listening when
 * the settings route mounts is a component that never sees it after a
 * client-side navigation. Everything below is about that single-shot lifetime.
 */

function fakeEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn(async () => undefined);
  return {
    event: {
      prompt,
      userChoice: Promise.resolve({ outcome }),
    } as unknown as BeforeInstallPromptEvent,
    prompt,
  };
}

afterEach(() => {
  resetInstallPromptForTests();
  vi.restoreAllMocks();
});

describe("the install prompt store", () => {
  it("has nothing to offer before the browser fires the event", () => {
    expect(hasInstallPrompt()).toBe(false);
  });

  it("holds the event so a component mounting later can still use it", () => {
    // The exact reason this is not a useEffect in the settings row.
    captureInstallPromptForTests(fakeEvent().event);
    expect(hasInstallPrompt()).toBe(true);
  });

  it("tells subscribers when the event arrives", () => {
    const seen = vi.fn();
    onInstallPromptChange(seen);
    captureInstallPromptForTests(fakeEvent().event);
    expect(seen).toHaveBeenCalled();
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const seen = vi.fn();
    onInstallPromptChange(seen)();
    captureInstallPromptForTests(fakeEvent().event);
    expect(seen).not.toHaveBeenCalled();
  });

  it("shows the prompt and reports what the reader chose", async () => {
    const { event, prompt } = fakeEvent("accepted");
    captureInstallPromptForTests(event);
    await expect(promptInstall()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("reports a dismissal as a decision, not an error", async () => {
    captureInstallPromptForTests(fakeEvent("dismissed").event);
    await expect(promptInstall()).resolves.toBe("dismissed");
  });

  it("spends the event on first use, because Chrome refuses a second prompt", async () => {
    const { event, prompt } = fakeEvent();
    captureInstallPromptForTests(event);
    await promptInstall();
    expect(hasInstallPrompt()).toBe(false);
    await expect(promptInstall()).resolves.toBe("unavailable");
    // Not "called once more and ignored" — never called again at all.
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("survives a prompt() that throws", async () => {
    const event = {
      prompt: async () => {
        throw new Error("already used");
      },
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    } as unknown as BeforeInstallPromptEvent;
    captureInstallPromptForTests(event);
    await expect(promptInstall()).resolves.toBe("dismissed");
  });

  it("has nothing to offer when there is nothing to prompt with", async () => {
    await expect(promptInstall()).resolves.toBe("unavailable");
  });
});

describe("capturing", () => {
  it("registers exactly one pair of listeners however often it is called", () => {
    const add = vi.spyOn(window, "addEventListener");
    startCapturingInstallPrompt();
    startCapturingInstallPrompt();
    startCapturingInstallPrompt();
    const events = add.mock.calls.map(([name]) => name);
    expect(events.filter((e) => e === "beforeinstallprompt")).toHaveLength(1);
    expect(events.filter((e) => e === "appinstalled")).toHaveLength(1);
  });

  it("takes the event away from the browser's own infobar", () => {
    startCapturingInstallPrompt();
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    const prevented = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    // Without preventDefault, Chrome shows its mini-infobar and the deferred
    // event is never usable — the button would have nothing to prompt with.
    expect(prevented).toHaveBeenCalled();
    expect(hasInstallPrompt()).toBe(true);
  });

  it("drops the offer when the app is installed by any route", () => {
    startCapturingInstallPrompt();
    captureInstallPromptForTests(fakeEvent().event);
    // Fired whether the install came from our button or the browser's own
    // menu, which is why the button cannot just trust its own return value.
    window.dispatchEvent(new Event("appinstalled"));
    expect(wasInstalled()).toBe(true);
    expect(hasInstallPrompt()).toBe(false);
  });
});

describe("already installed", () => {
  it("recognises a standalone window", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(isRunningStandalone()).toBe(true);
  });

  it("recognises Safari's non-standard flag, the only signal on iOS", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
    expect(isRunningStandalone()).toBe(true);
    Reflect.deleteProperty(window.navigator, "standalone");
  });

  it("is false in an ordinary tab", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    expect(isRunningStandalone()).toBe(false);
  });
});
