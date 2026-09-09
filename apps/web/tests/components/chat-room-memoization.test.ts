// @vitest-environment jsdom
//
// Regression coverage for the chat re-render memoization perf fix
// (PR #617 follow-up #1): MessageBubble is now React.memo'd and every
// per-row callback passed to it (react/edit/delete/select/menu-toggle) is a
// stable, id-parameterized function instead of a fresh closure created in
// the `messages.map(...)` — so typing in the composer must not re-render
// bubbles for messages that didn't change. `beginEdit` in particular used to
// depend on `[body, editing]`, which churned its identity on every keystroke
// and silently defeated the memo on the exact hot path this fix targets.
//
// The `react` module is mocked (via `importOriginal`) to wrap `memo`'s inner
// render function with a per-message-id call counter — no production code
// instrumentation needed, and `memo`'s real comparator/behavior is preserved.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@spiralclass/shared";

const renderCounts = new Map<string, number>();

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    memo: (<P extends { message?: { id?: string } }>(render: (props: P) => unknown) => {
      const counted = (props: P) => {
        const id = props?.message?.id;
        if (id) renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
        return render(props);
      };
      return actual.memo(counted as never);
    }) as typeof actual.memo,
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real useT() memoizes its returned translator by locale (see
// locale-provider.tsx), so it's a stable reference across re-renders as long
// as the locale doesn't change — mirror that here. A naive `() => (key) =>
// key` mock would hand MessageBubble a fresh `t` prop every render and
// falsely defeat the memo regardless of the fix under test.
const stableT = (key: string) => key;
vi.mock("@/components/locale-provider", () => ({
  useT: () => stableT,
}));

// chat-room.tsx compiles with the classic JSX runtime, which expects `React`
// in scope (same requirement as the other jsdom component tests).
(globalThis as Record<string, unknown>).React = await import("react");

const { ChatRoom } = await import("@/components/chat-room");

function makeMessage(id: string, senderRole: "teacher" | "student", body: string): ChatMessage {
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
    createdAt: new Date().toISOString(),
    readAt: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
  };
}

const MESSAGES: ChatMessage[] = [
  makeMessage("m1", "student", "hola"),
  makeMessage("m2", "teacher", "buenas"),
  makeMessage("m3", "student", "gracias"),
];

function textareaFor(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("composer textarea not found");
  return el;
}

// jsdom's <textarea> value setter isn't the native one React's controlled
// input relies on for change detection — use the prototype setter so
// dispatching "input" actually flows through React's onChange.
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ChatRoom — MessageBubble memoization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renderCounts.clear();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MESSAGES,
    }) as unknown as typeof fetch;
    // jsdom doesn't implement Element.scrollTo — the message list scrolls to
    // bottom on every message-count change.
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

  async function renderChatRoom() {
    await act(async () => {
      root.render(
        (await import("react")).createElement(ChatRoom, {
          messagesUrl: "/api/chat/messages",
          voiceUrl: "/api/chat/voice",
          videoUrl: "/api/chat/video",
          imageUrl: "/api/chat/image",
          fileUrl: "/api/chat/file",
          myRole: "teacher",
          peerName: "Mira",
          locale: "es-MX",
          initialMessages: MESSAGES,
        }),
      );
    });
  }

  it("does not re-render existing bubbles while typing in the composer", async () => {
    await renderChatRoom();
    // The initial mount + the background poll's first fetch both settle
    // inside renderChatRoom(); snapshot a clean baseline before typing so
    // this only measures re-renders CAUSED by composer keystrokes.
    renderCounts.clear();

    const textarea = textareaFor(container);
    for (const value of ["h", "ho", "hol", "hola"]) {
      await act(async () => typeInto(textarea, value));
    }

    // No bubble should have rendered again — the composer's `body` state
    // churning on every keystroke must not cascade into the memoized rows.
    expect(renderCounts.get("m1")).toBeUndefined();
    expect(renderCounts.get("m2")).toBeUndefined();
    expect(renderCounts.get("m3")).toBeUndefined();
  });

  it("still lets edit/react/select/delete target the right message after the memo refactor", async () => {
    await renderChatRoom();

    // Open the edit affordance on the teacher's own message (m2) via the
    // stable, id-parameterized onEdit path and confirm the composer picks up
    // that message's body — proving beginEdit(m) still resolves the right
    // message even though it's now a single stable function shared by every
    // row instead of a per-row inline closure.
    // DOM order matches MESSAGES order (m1 student, m2 teacher, m3 student) —
    // index 1 is m2's menu button, the teacher's own editable message.
    const menuButtons = container.querySelectorAll('[aria-label="web.chatRoom.messageActions"]');
    expect(menuButtons.length).toBe(3);

    await act(async () => {
      (menuButtons[1] as HTMLButtonElement).click();
    });

    // The menu panel is portalled to the document (it has to be: it used to be
    // clipped by the message list's own scroll box), so it is not under
    // `container`.
    const editButton = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("chat.actions.edit"),
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton!.click();
    });

    const textarea = textareaFor(container);
    expect(textarea.value).toBe("buenas");
  });
});
