// @vitest-environment jsdom
//
// Interactive coverage for the first-party "Report a problem" dialog that
// replaced Sentry's own feedback widget. What's pinned here is the behaviour
// the SDK's dialog either got wrong or never had: the copy resolves through
// the shared i18n catalog (not a language frozen at SDK-init time), an
// unusable report is refused before it costs a round trip, a failed send is
// recoverable rather than silent, the draft survives a dismiss, and the
// screenshot rides along as a Sentry attachment.
//
// No @testing-library/react in this repo — interactive component tests use raw
// react-dom/client (createRoot + act()) with manual DOM querying and native
// event dispatching. See tests/materials/block-editor.test.tsx for the pattern
// this file follows, including the native-setter trick needed to fire React's
// onChange from a programmatic `.value` assignment.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Echo the catalog KEY rather than a rendered string, so the assertions below
// pin structure and wiring instead of copy — and so a re-worded string never
// fails a test that isn't about wording.
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars
      ? `${key}(${Object.entries(vars)
          .map(([k, v]) => `${k}=${v}`)
          .join(",")})`
      : key,
  useLocale: () => "en",
}));

const sendFeedback = vi.fn(async () => "feedback-id");
const getUser = vi.fn(() => ({}) as { email?: string; username?: string });
const getClient = vi.fn(() => ({}) as unknown);

vi.mock("@sentry/nextjs", () => ({
  sendFeedback: (...args: unknown[]) => sendFeedback(...(args as [])),
  getCurrentScope: () => ({ getUser }),
  getClient: () => getClient(),
  lastEventId: () => "last-event-id",
}));

vi.mock("@/lib/analytics/posthog-browser", () => ({
  getSupportContext: () => ({ distinctId: null, replayUrl: null }),
}));

const { ReportProblemDialog } = await import("@/components/report-problem-dialog");
const { FEEDBACK_MESSAGE_MAX } = await import("@/lib/feedback");

const GOOD_MESSAGE = "The buy button does nothing on my phone.";

describe("ReportProblemDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  // Typed with the prop's own signature: vitest 5's bare `vi.fn()` is
  // `Mock<Procedure | Constructable>`, which no longer satisfies a concrete
  // callback prop. Naming the signature also means a changed prop shape
  // fails here rather than passing a wrongly-shaped spy into the component.
  let onOpenChange: Mock<(open: boolean) => void>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendFeedback.mockClear();
    sendFeedback.mockResolvedValue("feedback-id");
    getUser.mockReturnValue({});
    getClient.mockReturnValue({});
    // jsdom implements neither; the screenshot preview needs both, and the
    // revoke runs from a cleanup effect during unmount, so the stub has to
    // outlive every test body.
    createObjectURL = vi.fn(() => "blob:preview");
    revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenChange = vi.fn<(open: boolean) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(open = true) {
    act(() => {
      root.render(React.createElement(ReportProblemDialog, { open, onOpenChange }));
    });
  }

  // Radix portals the dialog to document.body, so queries run against the
  // document rather than the render container.
  function dialog(): HTMLElement {
    const el = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!el) throw new Error("dialog not open");
    return el;
  }

  function query<T extends Element>(selector: string): T | null {
    return document.querySelector<T>(selector);
  }

  function textarea(): HTMLTextAreaElement {
    const el = query<HTMLTextAreaElement>('[role="dialog"] textarea');
    if (!el) throw new Error("no message field");
    return el;
  }

  function inputByType(type: string): HTMLInputElement | null {
    return query<HTMLInputElement>(`[role="dialog"] input[type="${type}"]`);
  }

  function buttonWithText(text: string): HTMLButtonElement {
    const match = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((el) => el.textContent?.includes(text));
    if (!match) throw new Error(`no button containing ${text}`);
    return match;
  }

  function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    act(() => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submit() {
    const form = query<HTMLFormElement>('[role="dialog"] form')!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function lastPayload() {
    expect(sendFeedback).toHaveBeenCalled();
    return sendFeedback.mock.calls[sendFeedback.mock.calls.length - 1] as unknown as [
      {
        message: string;
        name?: string;
        email?: string;
        tags?: Record<string, string>;
        associatedEventId?: string;
      },
      { includeReplay?: boolean; attachments?: { filename: string; data: Uint8Array }[] },
    ];
  }

  // ---------- it renders at all ----------

  it("renders nothing until it is opened", () => {
    render(false);
    expect(query('[role="dialog"]')).toBeNull();
  });

  it("takes every visible string from the shared catalog", () => {
    render();
    const text = dialog().textContent ?? "";
    // The old widget's copy was configured in Spanish at SDK-init time. Every
    // string here resolves through t(), which is what the key echo proves.
    expect(text).toContain("common.reportProblem");
    expect(text).toContain("feedback.description");
    expect(text).toContain("feedback.messageLabel");
    expect(text).toContain("feedback.topicLabel");
    expect(text).toContain("feedback.submit");
    expect(text).toContain("common.cancel");
  });

  it("names the attachment size cap from the one constant that enforces it", () => {
    render();
    expect(dialog().textContent).toContain("feedback.attachHint(max=5)");
  });

  // ---------- validation ----------

  it("refuses a too-short report without spending a round trip", async () => {
    render();
    setValue(textarea(), "broken");
    await submit();
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("feedback.tooShort");
    expect(textarea().getAttribute("aria-invalid")).toBe("true");
  });

  it("points the field's aria-describedby at the error it just raised", async () => {
    render();
    setValue(textarea(), "broken");
    await submit();
    const described = textarea().getAttribute("aria-describedby") ?? "";
    const errorEl = document.getElementById(described.split(" ").at(-1)!);
    expect(errorEl?.textContent).toBe("feedback.tooShort");
    expect(errorEl?.getAttribute("role")).toBe("alert");
  });

  it("clears the error as soon as the field is edited", async () => {
    render();
    setValue(textarea(), "broken");
    await submit();
    expect(dialog().textContent).toContain("feedback.tooShort");
    setValue(textarea(), GOOD_MESSAGE);
    expect(dialog().textContent).not.toContain("feedback.tooShort");
  });

  it("rejects an implausible email but accepts an empty one", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    setValue(inputByType("email")!, "mira@");
    await submit();
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("feedback.emailInvalid");

    setValue(inputByType("email")!, "");
    await submit();
    expect(sendFeedback).toHaveBeenCalledTimes(1);
  });

  it("caps the message at the catalogued maximum", () => {
    render();
    setValue(textarea(), "x".repeat(FEEDBACK_MESSAGE_MAX + 50));
    expect(textarea().value).toHaveLength(FEEDBACK_MESSAGE_MAX);
  });

  it("keeps the character counter out of the way until the cap is in sight", () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    expect(dialog().textContent).not.toContain(`/ ${FEEDBACK_MESSAGE_MAX}`);
    setValue(textarea(), "x".repeat(FEEDBACK_MESSAGE_MAX));
    expect(dialog().textContent).toContain(`/ ${FEEDBACK_MESSAGE_MAX}`);
  });

  // ---------- the payload ----------

  it("sends the report with the triage topic, the replay and the last error event", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    const [params, hint] = lastPayload();
    expect(params.message).toContain(GOOD_MESSAGE);
    expect(params.tags).toEqual({ feedback_topic: "bug" });
    expect(params.associatedEventId).toBe("last-event-id");
    expect(hint.includeReplay).toBe(true);
  });

  it("appends the page and browser so a report raised off a clean page still has context", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    const [params] = lastPayload();
    expect(params.message).toContain(window.location.href);
    expect(params.message).toContain(navigator.userAgent);
  });

  it("tags the topic the user actually picked", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    const billing = query<HTMLInputElement>('[role="dialog"] input[value="billing"]')!;
    act(() => billing.click());
    await submit();
    expect(lastPayload()[0].tags).toEqual({ feedback_topic: "billing" });
  });

  it("prefills identity from the Sentry scope and keeps the fields out of the way", () => {
    getUser.mockReturnValue({ email: "mira@example.com", username: "Mira Luz" });
    render();
    expect(dialog().textContent).toContain("feedback.sendingAs(email=mira@example.com)");
    expect(inputByType("email")).toBeNull();
  });

  it("reveals the identity fields on request, still prefilled", () => {
    getUser.mockReturnValue({ email: "mira@example.com", username: "Mira Luz" });
    render();
    act(() => buttonWithText("feedback.editDetails").click());
    expect(inputByType("email")!.value).toBe("mira@example.com");
    expect(query<HTMLInputElement>('[role="dialog"] input[autocomplete="name"]')!.value).toBe(
      "Mira Luz",
    );
  });

  it("sends the prefilled identity even though its fields were never shown", async () => {
    getUser.mockReturnValue({ email: "mira@example.com", username: "Mira Luz" });
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    const [params] = lastPayload();
    expect(params.email).toBe("mira@example.com");
    expect(params.name).toBe("Mira Luz");
  });

  // ---------- outcomes ----------

  it("confirms in place, and announces the outcome for a screen reader", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    expect(dialog().textContent).toContain("feedback.thankYou");
    expect(query('[role="dialog"] [role="status"]')?.textContent).toBe("feedback.received");
    expect(query('[role="dialog"] form')).toBeNull();
  });

  it("keeps a failed report on screen with its text intact so it can be retried", async () => {
    sendFeedback.mockRejectedValueOnce(new Error("network"));
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    expect(dialog().textContent).toContain("feedback.failed");
    expect(query('[role="dialog"] [role="alert"]')).not.toBeNull();
    expect(textarea().value).toBe(GOOD_MESSAGE);

    await submit();
    expect(sendFeedback).toHaveBeenCalledTimes(2);
    expect(dialog().textContent).toContain("feedback.thankYou");
  });

  it("falls back to email when the deploy has no Sentry client, rather than dropping the report", async () => {
    getClient.mockReturnValue(null);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, href: "https://spiralclass.com/my-classes", assign },
      writable: true,
      configurable: true,
    });
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(String(window.location.href)).toContain("mailto:");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // ---------- the screenshot ----------

  it("attaches a picked screenshot to the report", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);

    const file = {
      name: "screenshot.png",
      type: "image/png",
      size: 2048,
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    } as unknown as File;
    const picker = query<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(dialog().textContent).toContain("screenshot.png");
    await submit();
    const [, hint] = lastPayload();
    expect(hint.attachments).toHaveLength(1);
    expect(hint.attachments![0]!.filename).toBe("screenshot.png");
    expect(Array.from(hint.attachments![0]!.data)).toEqual([137, 80, 78, 71]);
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it("revokes the preview URL when the screenshot is removed", async () => {
    render();
    const file = {
      name: "screenshot.png",
      type: "image/png",
      size: 2048,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as unknown as File;
    const picker = query<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const remove = query<HTMLButtonElement>(
      '[role="dialog"] [aria-label^="feedback.attachRemove"]',
    )!;
    await act(async () => remove.click());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(dialog().textContent).not.toContain("screenshot.png");
  });

  it("explains a file it cannot attach instead of silently ignoring it", async () => {
    render();
    const picker = query<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
    Object.defineProperty(picker, "files", {
      value: [{ name: "notes.pdf", type: "application/pdf", size: 10 } as unknown as File],
      configurable: true,
    });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(dialog().textContent).toContain("feedback.attachInvalidType");
  });

  // ---------- the draft ----------

  it("keeps a half-written report when the dialog is dismissed", () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    render(false);
    render(true);
    expect(textarea().value).toBe(GOOD_MESSAGE);
  });

  it("clears the draft once it has actually been sent", async () => {
    render();
    setValue(textarea(), GOOD_MESSAGE);
    await submit();
    act(() => buttonWithText("feedback.close").click());
    render(false);
    render(true);
    expect(textarea().value).toBe("");
  });
});
