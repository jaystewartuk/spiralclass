// @vitest-environment jsdom
//
// A student who moved from Vienna to Toronto went on reading every class time
// on Vienna's clock: the portal fills a zone only when none is saved (D-53),
// so nothing ever noticed the move. The portal now OFFERS the device's zone
// when it is a different clock, switches only on her tap, and remembers
// "Keep" for that exact pair.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const switchMyTimezoneAction = vi.fn(async (_zone: string) => state.result);
vi.mock("@/app/actions/student-contact", () => ({ switchMyTimezoneAction }));
const refresh = vi.fn();
const nav = { pathname: "/my-classes" };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => nav.pathname,
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

const state = { result: { ok: "Details saved." } as { ok?: string; error?: string } };

const { LocaleProvider } = await import("@/components/locale-catalog");
const { TimezoneMismatchNotice, KEPT_ZONE_STORAGE_KEY, keptPair } =
  await import("@/app/(student)/my-classes/timezone-mismatch-notice");

let container: HTMLDivElement;
let root: Root;

function deviceIn(zone: string) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: zone };
  });
}

function render(saved: string, locale: "en" | "es" = "en") {
  act(() =>
    root.render(
      <LocaleProvider locale={locale}>
        <TimezoneMismatchNotice savedTimezone={saved} />
      </LocaleProvider>,
    ),
  );
}

const buttons = () => Array.from(container.querySelectorAll("button"));
const button = (text: string) => buttons().find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  window.localStorage.clear();
  state.result = { ok: "Details saved." };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("TimezoneMismatchNotice", () => {
  it("offers the device's city when it is a different clock from the saved one", () => {
    deviceIn("America/Toronto");
    render("Europe/Vienna");
    expect(container.textContent).toContain(
      "Your class times are shown in Vienna time, but this device is set to Toronto time.",
    );
    expect(container.textContent).toContain("Booked classes don't move");
    expect(button("Use Toronto time")).toBeTruthy();
    expect(button("Keep Vienna time")).toBeTruthy();
    expect(switchMyTimezoneAction).not.toHaveBeenCalled();
  });

  it("stays out of the way during a class", () => {
    deviceIn("America/Toronto");
    nav.pathname = "/my-classes/b1/call";
    try {
      render("Europe/Vienna");
      expect(container.textContent).toBe("");
    } finally {
      nav.pathname = "/my-classes";
    }
  });

  it("speaks the student's language", () => {
    deviceIn("America/Toronto");
    render("Europe/Vienna", "es");
    expect(container.textContent).toContain(
      "Tus horarios de clase se muestran en hora de Vienna, pero este dispositivo está en hora de Toronto.",
    );
    expect(button("Usar hora de Toronto")).toBeTruthy();
  });

  it("says nothing when the device shows the same clock under another name", () => {
    deviceIn("Europe/Berlin");
    render("Europe/Vienna");
    expect(container.textContent).toBe("");
  });

  it("says nothing when the device is in the saved zone", () => {
    deviceIn("Europe/Vienna");
    render("Europe/Vienna");
    expect(container.textContent).toBe("");
  });

  it("switches only on her tap, then refreshes the portal", async () => {
    deviceIn("America/Toronto");
    render("Europe/Vienna");
    await act(async () => button("Use Toronto time").click());
    expect(switchMyTimezoneAction).toHaveBeenCalledWith("America/Toronto");
    expect(refresh).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Done — your class times now show in Toronto time.");
    expect(container.textContent).toBe("");
  });

  it("keeps the notice and shows the error when the switch fails", async () => {
    state.result = { error: "That time zone isn't valid." };
    deviceIn("America/Toronto");
    render("Europe/Vienna");
    await act(async () => button("Use Toronto time").click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "That time zone isn't valid.",
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(button("Use Toronto time")).toBeTruthy();
  });

  it("remembers Keep for this pair, and asks again from a third city", () => {
    deviceIn("America/Toronto");
    render("Europe/Vienna");
    act(() => button("Keep Vienna time").click());
    expect(container.textContent).toBe("");
    expect(window.localStorage.getItem(KEPT_ZONE_STORAGE_KEY)).toBe(
      keptPair("Europe/Vienna", "America/Toronto"),
    );
    expect(switchMyTimezoneAction).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    render("Europe/Vienna");
    expect(container.textContent).toBe("");

    vi.restoreAllMocks();
    deviceIn("Asia/Tokyo");
    act(() => root.unmount());
    root = createRoot(container);
    render("Europe/Vienna");
    expect(button("Use Tokyo time")).toBeTruthy();
  });

  it("still offers the switch when this browser's storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    deviceIn("America/Toronto");
    render("Europe/Vienna");
    expect(button("Keep Vienna time")).toBeTruthy();
    act(() => button("Keep Vienna time").click());
    expect(container.textContent).toBe("");
  });
});
