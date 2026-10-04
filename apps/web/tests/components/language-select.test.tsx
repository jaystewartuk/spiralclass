// @vitest-environment jsdom
//
// The language switcher (D-193). On a public page whose URL names its
// language, the cookie cannot change the page — `/es/pricing` is Spanish
// whatever it says — so the switcher saves the choice and then loads the
// chosen language's URL for the same page, as a new document. Everywhere else
// it submits the form as it always has.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

const chooseLocaleAction = vi.fn();
const setLocaleAction = vi.fn(async () => {});
vi.mock("@/app/actions/locale", () => ({ chooseLocaleAction, setLocaleAction }));
const hardNavigate = vi.fn();
vi.mock("@/lib/hard-navigate", () => ({ hardNavigate }));
vi.mock("@/components/locale-provider", () => ({ useT: () => (key: string) => key }));

const { LanguageSelect } = await import("@/components/language-select");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function choose(url: string, value: string) {
  window.history.pushState({}, "", url);
  act(() => root.render(<LanguageSelect current="system" />));
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("LanguageSelect", () => {
  it("loads the chosen language's URL for the same page, keeping the query and fragment", async () => {
    chooseLocaleAction.mockResolvedValue({ locale: "fr" });
    await choose("/es/help/teachers?q=pay#top", "fr");
    expect(chooseLocaleAction).toHaveBeenCalledTimes(1);
    expect((chooseLocaleAction.mock.calls[0][0] as FormData).get("locale")).toBe("fr");
    expect(hardNavigate).toHaveBeenCalledWith("/fr/help/teachers?q=pay#top");
    expect(setLocaleAction).not.toHaveBeenCalled();
  });

  it("sends a choice of English to the bare URL", async () => {
    chooseLocaleAction.mockResolvedValue({ locale: "en" });
    await choose("/es/pricing", "en");
    expect(hardNavigate).toHaveBeenCalledWith("/pricing");
  });

  it("follows System Default to whichever language it resolved to", async () => {
    chooseLocaleAction.mockResolvedValue({ locale: "es" });
    await choose("/pricing", "system");
    expect(hardNavigate).toHaveBeenCalledWith("/es/pricing");
  });

  it("goes nowhere when the choice was refused", async () => {
    chooseLocaleAction.mockResolvedValue(null);
    await choose("/pricing", "fr");
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it("submits the form as before on a page the URL does not decide", async () => {
    await choose("/dashboard", "fr");
    expect(chooseLocaleAction).not.toHaveBeenCalled();
    expect(hardNavigate).not.toHaveBeenCalled();
    expect(setLocaleAction).toHaveBeenCalledTimes(1);
  });
});
