// @vitest-environment jsdom
//
// The consent block on a teacher's student page. Its two consents used to
// share one row, where the insights button's bare "✓ Consent on file" sat
// above a captions note and read as the captions consent: a teacher was told,
// in effect, that a student who had never turned captions on had. Each consent
// now sits under its own heading, and an adult's captions state is shown
// rather than left to the teacher to guess.
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
vi.mock("@/app/actions/insights-consent", () => ({ setInsightsConsent: vi.fn() }));
vi.mock("@/app/actions/captions-consent", () => ({ setCaptionsGuardianConsent: vi.fn() }));

const { InsightsConsentControl } =
  await import("@/app/(app)/dashboard/students/[studentId]/insights-consent-control");

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
});

function render(props: Partial<React.ComponentProps<typeof InsightsConsentControl>> = {}) {
  act(() =>
    root.render(
      <InsightsConsentControl
        studentId="s1"
        consented
        isMinor={false}
        captionsGuardianConsented={false}
        captionsSelfConsented={false}
        {...props}
      />,
    ),
  );
  return container;
}

// The heading each piece of text sits under.
function sectionOf(text: string): string | null {
  const el = [...container.querySelectorAll("p, button")].find((n) => n.textContent === text);
  return el?.closest("div.space-y-1")?.querySelector("h4")?.textContent ?? null;
}

describe("InsightsConsentControl", () => {
  it("puts the insights consent under its own heading, not the captions one", () => {
    render();
    expect(sectionOf("web.insightsConsent.recorded")).toBe("web.insightsConsent.heading");
  });

  it("tells the teacher an adult has not turned captions on yet", () => {
    render();
    expect(sectionOf("web.captionsConsent.selfOff")).toBe("web.captionsConsent.heading");
    expect(container.textContent).not.toContain("web.captionsConsent.selfOn");
  });

  it("tells the teacher an adult has turned captions on", () => {
    render({ captionsSelfConsented: true });
    expect(sectionOf("web.captionsConsent.selfOn")).toBe("web.captionsConsent.heading");
  });

  it("gives the teacher the guardian's consent to record for a minor", () => {
    render({ isMinor: true, captionsSelfConsented: true });
    expect(sectionOf("web.captionsConsent.record")).toBe("web.captionsConsent.heading");
    expect(container.textContent).not.toContain("web.captionsConsent.selfOn");
  });
});
