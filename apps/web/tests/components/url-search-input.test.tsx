// @vitest-environment jsdom
//
// The URL-backed search box. #1001 extracted this from the teacher library's
// own `MaterialSearch` so the student shelf could reuse it, and deleted that
// component along with its tests — leaving the shared replacement, now used by
// two screens, with no coverage at all. This is that coverage, carried over.
//
// What is worth guarding is the URL contract rather than the debounce: the
// field seeds itself from the param so a bookmarked search shows its own
// terms, a new query restarts the page window (a `?page=3` carried into a
// narrower result set lands the reader on an empty page nobody asked for),
// and every write is a soft `replace` so the field never remounts mid-word.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/dashboard/materials",
  useSearchParams: () => searchParams,
}));

const { UrlSearchInput } = await import("@/components/ui/url-search-input");

describe("UrlSearchInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  // React patches the `value` setter on the DOM node to track changes, so a
  // plain `input.value = x` is invisible to it and onChange never fires — the
  // native setter is what an actual keystroke goes through.
  function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function render(initial = "", props: Record<string, unknown> = {}) {
    searchParams = new URLSearchParams(initial);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(UrlSearchInput, { placeholder: "Search your materials", ...props }),
      );
    });
    return container.querySelector<HTMLInputElement>("input")!;
  }

  beforeEach(() => {
    replace.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
  });

  it("seeds itself from the param so a bookmarked search shows its own terms", () => {
    expect(render("q=past+simple").value).toBe("past simple");
  });

  it("waits for the typing to stop before navigating", () => {
    const input = render();
    act(() => type(input, "pas"));
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(replace).toHaveBeenCalledWith("/dashboard/materials?q=pas", { scroll: false });
  });

  it("writes only the last keystroke, not one navigation per letter", () => {
    const input = render();
    act(() => type(input, "p"));
    act(() => type(input, "pa"));
    act(() => type(input, "pas"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/dashboard/materials?q=pas", { scroll: false });
  });

  it("restarts the page window on a new search, keeping the other filters", () => {
    // `clearParams` is the caller's declaration of what a new query
    // invalidates; the materials page passes ["page"] for exactly this reason.
    const input = render("page=3&level=lvl-a2", { clearParams: ["page"] });
    act(() => type(input, "verbs"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const params = new URLSearchParams(replace.mock.calls[0][0].split("?")[1]);
    expect(params.get("page")).toBeNull();
    expect(params.get("level")).toBe("lvl-a2");
    expect(params.get("q")).toBe("verbs");
  });

  it("drops the param entirely once the field is emptied", () => {
    const input = render("q=verbs");
    act(() => type(input, "   "));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // No trailing "?", so the cleared state is the bare path.
    expect(replace).toHaveBeenCalledWith("/dashboard/materials", { scroll: false });
  });

  it("owns whichever param it was given, not always q", () => {
    const input = render("", { param: "search" });
    act(() => type(input, "verbs"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).toHaveBeenCalledWith("/dashboard/materials?search=verbs", { scroll: false });
  });

  it("names itself for a screen reader, and lets a caller override it", () => {
    expect(render().getAttribute("aria-label")).toBe("Search your materials");
    act(() => root.unmount());
    container.remove();
    expect(render("", { label: "Search the library" }).getAttribute("aria-label")).toBe(
      "Search the library",
    );
  });
});
