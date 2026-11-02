// @vitest-environment jsdom
//
// The subtitle timing form. A save must leave the dropdowns showing what was
// saved: React resets a form once its action settles, and a controlled <select>
// then snaps back to the option it had on first render — so the teacher saw
// the old value beside a "saved" message, and the stored value was right all
// along.
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

const save = vi.fn(async (_prev: unknown, _formData: FormData) => ({ ok: true }) as const);
vi.mock("@/app/actions/caption-timing", () => ({
  saveCaptionTimingAction: (prev: unknown, formData: FormData) => save(prev, formData),
}));

const { CaptionTimingForm } = await import("@/app/(app)/settings/captions/caption-timing-form");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  save.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function selects() {
  return [...container.querySelectorAll<HTMLSelectElement>("select")];
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
  });
}

describe("CaptionTimingForm", () => {
  it("keeps the dropdowns on the value that was just saved", async () => {
    act(() => root.render(<CaptionTimingForm initial={{ pauseMs: 0, maxChars: 60 }} />));
    const [, chars] = selects();
    choose(chars!, "80");
    expect(chars!.value).toBe("80");

    await submit();

    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]![1];
    expect(sent.get("maxChars")).toBe("80");
    expect(selects()[1]!.value).toBe("80");
  });

  it("keeps both dropdowns after changing both, and sends both", async () => {
    act(() => root.render(<CaptionTimingForm initial={{ pauseMs: 0, maxChars: 0 }} />));
    choose(selects()[0]!, "700");
    choose(selects()[1]!, "100");

    await submit();

    const sent = save.mock.calls[0]![1];
    expect([sent.get("pauseMs"), sent.get("maxChars")]).toEqual(["700", "100"]);
    expect([selects()[0]!.value, selects()[1]!.value]).toEqual(["700", "100"]);
  });
});
