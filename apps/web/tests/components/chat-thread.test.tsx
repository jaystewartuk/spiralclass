// @vitest-environment jsdom
//
// Behavioural cover for the thread's three load-bearing interactions, none of
// which had any test before: run grouping (what the thread LOOKS like),
// optimistic send (what happens between pressing Enter and the server
// answering), and the follow-the-conversation rule (whether an arriving
// message is allowed to move the reader).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@spiralclass/shared";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));

// Mirrors the real useT()'s stable-per-locale identity (locale-provider.tsx),
// so the memoized rows are not defeated by the mock itself.
const stableT = (key: string, vars?: Record<string, string | number>) =>
  vars?.count === undefined ? key : `${key}:${vars.count}`;
vi.mock("@/components/locale-provider", () => ({ useT: () => stableT }));

(globalThis as Record<string, unknown>).React = await import("react");

const { ChatRoom } = await import("@/components/chat-room");

function makeMessage(
  id: string,
  senderRole: "teacher" | "student",
  body: string,
  createdAt: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    senderRole,
    body,
    replyToId: null,
    replyPreview: null,
    voiceUrl: null,
    voiceDurationMs: null,
    videoUrl: null,
    videoDurationMs: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    fileUrl: null,
    fileName: null,
    fileSizeBytes: null,
    fileMimeType: null,
    createdAt,
    readAt: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    ...extra,
  };
}

/** Three messages: two from the student a minute apart, then the teacher. */
const BASE = new Date(2026, 8, 1, 10, 0, 0).getTime();
const MESSAGES: ChatMessage[] = [
  makeMessage("m1", "student", "hola", new Date(BASE).toISOString()),
  makeMessage("m2", "student", "dos cosas", new Date(BASE + 60_000).toISOString()),
  makeMessage("m3", "teacher", "claro", new Date(BASE + 120_000).toISOString()),
];

function textareaFor(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("composer textarea not found");
  return el;
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByLabel(label: string): HTMLButtonElement {
  const el = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled ${label}`);
  return el;
}

/** Time stamps that are actually shown — one per run; the rest stay in the
 * accessibility tree only. */
function visibleTimestamps(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("time")).filter(
    (el) => !el.parentElement?.classList.contains("sr-only"),
  );
}

describe("ChatRoom", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    toastError.mockClear();
    window.HTMLElement.prototype.scrollTo = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(
    initialMessages: ChatMessage[],
    fetchImpl: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => initialMessages,
    }) as unknown as typeof fetch,
  ) {
    global.fetch = fetchImpl;
    await act(async () => {
      root.render(
        (await import("react")).createElement(ChatRoom, {
          messagesUrl: "/api/chat/messages",
          voiceUrl: "/api/chat/voice",
          videoUrl: "/api/chat/video",
          imageUrl: "/api/chat/image",
          fileUrl: "/api/chat/file",
          myRole: "student",
          peerName: "Mira",
          locale: "es-MX",
          initialMessages,
        }),
      );
    });
  }

  it("shows one timestamp per run, not one per message", async () => {
    await render(MESSAGES);
    // Two runs: the student's pair, then the teacher's single message.
    expect(visibleTimestamps(container)).toHaveLength(2);
    // Every message still carries its time for assistive tech.
    expect(container.querySelectorAll("time")).toHaveLength(3);
  });

  it("names the sender once per run, for a screen reader", async () => {
    await render(MESSAGES);
    // The meta row is also visually hidden inside a run, so pick the labels
    // out by what they are NOT: they carry no timestamp.
    const senderLabels = Array.from(container.querySelectorAll("p.sr-only"))
      .filter((el) => !el.querySelector("time"))
      .map((el) => el.textContent);
    expect(senderLabels).toEqual(["chat.you", "Mira"]);
  });

  it("renders the message body as body text, not as supporting text", async () => {
    // D-140 puts the floor for body text at 17px (`text-base`); the bubble used
    // `text-sm`, the same step as its own timestamp.
    await render(MESSAGES);
    const body = Array.from(container.querySelectorAll("p")).find((p) => p.textContent === "hola");
    expect(body?.className).toContain("text-base");
  });

  it("paints a sent message immediately and marks it as sending", async () => {
    let resolvePost: (value: unknown) => void = () => {};
    const saved = makeMessage(
      "server-1",
      "student",
      "buenas",
      new Date(BASE + 200_000).toISOString(),
    );
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      }
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;

    await render([], fetchImpl);
    await act(async () => typeInto(textareaFor(container), "buenas"));
    await act(async () => buttonByLabel("web.chatRoom.sendMessage").click());

    expect(container.textContent).toContain("buenas");
    expect(container.textContent).toContain("chat.status.sending");
    // The draft is gone from the composer, not duplicated in it.
    expect(textareaFor(container).value).toBe("");

    await act(async () => {
      resolvePost({ ok: true, json: async () => saved });
    });

    expect(container.textContent).toContain("chat.status.sent");
    expect(container.textContent).not.toContain("chat.status.sending");
    // Exactly one copy of the message — the optimistic one was retired.
    expect(container.querySelectorAll("time")).toHaveLength(1);
  });

  it("gives the draft back when the send fails", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;

    await render([], fetchImpl);
    await act(async () => typeInto(textareaFor(container), "no llega"));
    await act(async () => buttonByLabel("web.chatRoom.sendMessage").click());

    expect(textareaFor(container).value).toBe("no llega");
    expect(toastError).toHaveBeenCalledWith("chat.sendFailed");
    // The optimistic bubble is gone, so the thread does not claim it was sent.
    expect(container.querySelectorAll("time")).toHaveLength(0);
  });

  it("offers the empty thread a prompt rather than a bare line of text", async () => {
    await render([]);
    expect(container.textContent).toContain("chat.empty.title");
    expect(container.textContent).toContain("chat.empty.student");
  });

  it("does not follow new messages while the reader is scrolled up", async () => {
    const arriving = makeMessage(
      "m4",
      "teacher",
      "una cosa más",
      new Date(BASE + 300_000).toISOString(),
    );
    // The mount's own poll must NOT already carry the new message, or the
    // reader is still "following" when it lands and the test proves nothing.
    let payload = MESSAGES;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => payload,
    })) as unknown as typeof fetch;

    await render(MESSAGES, fetchImpl);
    const list = container.querySelector<HTMLElement>('[role="log"]')!;
    // jsdom reports every scroll metric as 0, which reads as "at the bottom" —
    // stage a reader who has scrolled up to re-read something.
    Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: 0, configurable: true, writable: true });
    await act(async () => list.dispatchEvent(new Event("scroll")));

    expect(container.textContent).toContain("chat.jump.latest");

    // The focus listener is the same code path the 4-second poll runs.
    payload = [...MESSAGES, arriving];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(container.textContent).toContain("chat.jump.newCount:1");
    // And the list was not scrolled underneath them.
    expect(window.HTMLElement.prototype.scrollTo).toHaveBeenCalledTimes(1);
  });
});
