// @vitest-environment jsdom
//
// The call screen's new parts, each pinned on the thing it exists for:
//   - the camera-off placeholder says who is there and whether they are muted
//     or speaking, instead of a black stage;
//   - the top bar's lesson clock says how much of the class is left and turns
//     to a warning at the end;
//   - the phone's More menu offers its items and closes after one is chosen.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { Bookmark } from "lucide-react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useLocale: () => "en",
}));

const { ParticipantPlaceholder } = await import("@/components/video/participant-placeholder");
const { CallTopBar } = await import("@/components/video/call-top-bar");
const { CallMoreMenu } = await import("@/components/video/call-more-menu");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = (node: React.ReactNode) => act(() => root.render(node));
const view = {
  identity: "s1",
  name: "Farid Akbar",
  initials: "FA",
  camOn: false,
  micOn: true,
  speaking: false,
};

describe("ParticipantPlaceholder", () => {
  it("shows initials and the name on the stage", () => {
    render(<ParticipantPlaceholder view={view} size="big" style={{}} />);
    expect(container.textContent).toContain("FA");
    expect(container.textContent).toContain("Farid Akbar");
    expect(container.querySelector('[data-testid="participant-mic-off"]')).toBeNull();
  });

  it("badges a muted microphone", () => {
    render(<ParticipantPlaceholder view={{ ...view, micOn: false }} size="big" style={{}} />);
    expect(container.querySelector('[data-testid="participant-mic-off"]')?.textContent).toBe(
      "call.micOffBadge",
    );
  });

  it("lights while they speak", () => {
    render(<ParticipantPlaceholder view={{ ...view, speaking: true }} size="tile" style={{}} />);
    expect(container.querySelector("[data-speaking]")).not.toBeNull();
  });

  it("keeps a corner tile to initials", () => {
    render(<ParticipantPlaceholder view={view} size="tile" style={{}} />);
    expect(container.textContent).not.toContain("Farid Akbar");
  });
});

describe("CallTopBar", () => {
  const clock = () => container.querySelector('[data-testid="lesson-clock"]');

  it("says how much of the class is left", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-02T19:27:10Z") });
    render(
      <CallTopBar
        notes={null}
        otherName="Farid"
        startAt="2026-10-02T19:00:00Z"
        endAt="2026-10-02T19:50:00Z"
        controls={null}
      />,
    );
    expect(clock()?.textContent).toBe('call.clockLeft:{"minutes":23}');
    expect(clock()?.hasAttribute("data-warn")).toBe(false);
    expect(container.textContent).toContain("Farid");
  });

  it("ticks into the warning at the end of the class", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-02T19:44:50Z") });
    render(
      <CallTopBar
        notes={null}
        otherName={null}
        startAt="2026-10-02T19:00:00Z"
        endAt="2026-10-02T19:50:00Z"
        controls={null}
      />,
    );
    expect(clock()?.hasAttribute("data-warn")).toBe(false);
    act(() => vi.advanceTimersByTime(15_000));
    expect(clock()?.textContent).toBe('call.clockLeft:{"minutes":5}');
    expect(clock()?.hasAttribute("data-warn")).toBe(true);
  });

  it("lets open notes hang down past the bar, not clip to its height", () => {
    // The notes' containing block is the bar's 36px slot. A percentage cap
    // (`max-h-over-stage`, 70%) clipped an opened card to its own title, so
    // "My cues" toggled open and showed nothing. The cap is viewport-relative.
    render(<CallTopBar notes={<ul>cues</ul>} otherName={null} controls={null} />);
    const wrapper = container.querySelector("ul")!.parentElement!;
    expect(wrapper.className).toContain("max-h-under-bar");
    expect(wrapper.className).not.toContain("max-h-over-stage");
  });

  it("shows no clock without the class's times", () => {
    render(<CallTopBar notes={null} otherName={null} controls={null} />);
    expect(clock()).toBeNull();
  });
});

describe("CallMoreMenu", () => {
  it("opens, runs the chosen item, and closes", () => {
    const onSelect = vi.fn();
    render(<CallMoreMenu items={[{ key: "b", icon: Bookmark, label: "Bookmark", onSelect }]} />);
    const toggle = container.querySelector("button")!;
    expect(container.querySelector('[role="menu"]')).toBeNull();
    act(() => toggle.click());
    const item = container.querySelector('[role="menuitem"]') as HTMLButtonElement;
    expect(item.textContent).toBe("Bookmark");
    act(() => item.click());
    expect(onSelect).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes on Escape", () => {
    render(<CallMoreMenu items={[{ key: "b", icon: Bookmark, label: "B", onSelect: () => {} }]} />);
    act(() => container.querySelector("button")!.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("renders nothing with nothing to offer", () => {
    render(<CallMoreMenu items={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
