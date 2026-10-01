// @vitest-environment jsdom
//
// The student's in-call captions consent card. It must record HER consent
// with the same self-service action as her account page (never anything the
// teacher could trigger), tell the call to re-read the caption config only
// once that has succeeded, and let her say "Not now" without consenting.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const setCaptionsConsent = vi.fn();
vi.mock("@/app/actions/captions-consent", () => ({ setCaptionsConsent }));

const { CaptionsConsentAsk } = await import("@/components/video/captions-consent-ask");

let container: HTMLDivElement;
let root: Root;
const onGiven = vi.fn();
const onDismiss = vi.fn();

beforeEach(() => {
  setCaptionsConsent.mockReset();
  onGiven.mockReset();
  onDismiss.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CaptionsConsentAsk onGiven={onGiven} onDismiss={onDismiss} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;

async function click(label: string) {
  await act(async () => {
    button(label).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

describe("CaptionsConsentAsk", () => {
  it("says what turning it on does before she taps it", () => {
    expect(container.textContent).toContain("call.captionsConsentAskTitle");
    expect(container.textContent).toContain("call.captionsConsentAskBody");
  });

  it("records her own consent, then asks the call to re-read the config", async () => {
    setCaptionsConsent.mockResolvedValue({ ok: true });
    await click("call.captionsConsentAskAccept");
    expect(setCaptionsConsent).toHaveBeenCalledWith(true);
    expect(onGiven).toHaveBeenCalledOnce();
  });

  it("says so and does not report success when the save fails", async () => {
    setCaptionsConsent.mockResolvedValue({ error: "nope" });
    await click("call.captionsConsentAskAccept");
    expect(onGiven).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "call.captionsConsentAskFailed",
    );
  });

  it("'Not now' dismisses without consenting", async () => {
    await click("call.captionsConsentAskLater");
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(setCaptionsConsent).not.toHaveBeenCalled();
  });
});
