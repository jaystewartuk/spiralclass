// @vitest-environment jsdom
//
// The inbox rail is the new thing on Messages: a conversation list that stays
// on screen beside an open thread. Three behaviours carry it, and none of them
// is visible from the server render that mounts it — it keeps itself fresh by
// polling, it says which conversation is open, and it stops claiming a
// conversation is unread the moment you open it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "@spiralclass/shared";

const stableT = (key: string, vars?: Record<string, string | number>) =>
  vars === undefined ? key : `${key}:${Object.values(vars).join(",")}`;
vi.mock("@/components/locale-provider", () => ({ useT: () => stableT }));

let pathname = "/dashboard/messages";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

(globalThis as Record<string, unknown>).React = await import("react");

const { ThreadList } = await import("@/components/chat/thread-list");

function thread(
  over: Partial<ChatThread> & { studentId: string; studentName: string },
): ChatThread {
  return {
    lastMessage: {
      id: `m-${over.studentId}`,
      senderRole: "student",
      body: "hola",
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
      createdAt: "2026-09-05T10:00:00.000Z",
      readAt: null,
      editedAt: null,
      deletedAt: null,
      reactions: [],
    },
    lastMessageKind: "text",
    unreadCount: 0,
    ...over,
  };
}

const THREADS: ChatThread[] = [
  thread({ studentId: "s1", studentName: "José Ramírez", unreadCount: 3 }),
  thread({ studentId: "s2", studentName: "Marta Ibarra" }),
];

describe("ThreadList (the inbox rail)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    pathname = "/dashboard/messages";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(THREADS), { status: 200 })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(threads: ChatThread[] = THREADS) {
    act(() => {
      root.render(<ThreadList threads={threads} locale="en" timezone="America/Mexico_City" />);
    });
  }

  /**
   * A fresh mount. The rail seeds its state from the prop ONCE and owns the
   * list by polling from then on (the layout that renders it is never
   * re-rendered, so a later prop would never arrive in the real app either) —
   * so a test that wants different threads has to mount again, not re-render.
   */
  function remount(threads: ChatThread[]) {
    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(threads);
  }

  function rows(): HTMLAnchorElement[] {
    return [...container.querySelectorAll("a[href^='/dashboard/messages/']")].filter(
      (a) => a.getAttribute("href") !== "/dashboard/messages/new",
    ) as HTMLAnchorElement[];
  }

  it("lists every conversation, linking each to its own thread", () => {
    render();
    expect(rows().map((a) => a.getAttribute("href"))).toEqual([
      "/dashboard/messages/s1",
      "/dashboard/messages/s2",
    ]);
  });

  it("says how many messages are unread, in words as well as a pill", () => {
    render();
    // The pill alone is aria-hidden: "3" read aloud does not say 3 of what.
    expect(container.textContent).toContain("web.messages.unreadCount:3");
  });

  it("marks the open conversation as the current page", () => {
    pathname = "/dashboard/messages/s2";
    render();
    const current = rows().filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.getAttribute("href"))).toEqual(["/dashboard/messages/s2"]);
  });

  it("stops claiming a conversation is unread the moment it is opened", () => {
    render();
    expect(container.textContent).toContain("web.messages.unreadCount:3");
    act(() => {
      rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The server marks it read on open; without this the row would keep its
    // badge until the next poll landed.
    expect(container.textContent).not.toContain("web.messages.unreadCount:3");
  });

  it("polls the thread route, because the layout that mounts it never re-renders", () => {
    render();
    expect(fetch).toHaveBeenCalledWith("/api/chat/teacher/threads", expect.anything());
  });

  it("offers search only once the roster is long enough to need it", () => {
    render();
    expect(container.querySelector("input[type='search']")).toBeNull();

    const many = Array.from({ length: 6 }, (_, i) =>
      thread({ studentId: `s${i}`, studentName: `Student ${i}` }),
    );
    remount(many);
    expect(container.querySelector("input[type='search']")).not.toBeNull();
  });

  it("filters by name without demanding the accents", () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) =>
        thread({ studentId: `x${i}`, studentName: `Student ${i}` }),
      ),
      thread({ studentId: "s1", studentName: "José Ramírez" }),
    ];
    remount(many);
    const search = container.querySelector("input[type='search']") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(search, "jose");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().map((a) => a.getAttribute("href"))).toEqual(["/dashboard/messages/s1"]);
  });

  it("titles itself as the PAGE heading only when it is the page", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe("web.messages.title");

    pathname = "/dashboard/messages/s1";
    remount(THREADS);
    // Beside an open conversation the conversation owns the h1.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("web.messages.title");
  });
});
