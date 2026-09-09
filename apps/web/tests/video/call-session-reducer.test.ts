import { describe, expect, it } from "vitest";
import { callSessionReducer, type CallSessionInput } from "@/lib/video/call-session-reducer";

// The state transition behind cross-navigation call persistence
// (WHATSAPP_VIDEO_UX): a call started via "start" must survive whatever
// re-renders the app throws at it, but must refuse to silently swap to a
// DIFFERENT booking's call while one is already connected — the LiveKit
// connection key isn't room-sensitive enough to safely rug-pull the active
// <ClassCall> instance under a session swap (see the reducer's own note).

function session(bookingId: string, extra: Partial<CallSessionInput> = {}): CallSessionInput {
  return {
    bookingId,
    grant: { url: "wss://example.invalid", token: `tok-${bookingId}` },
    backHref: `/back/${bookingId}`,
    callHref: `/call/${bookingId}`,
    ...extra,
  };
}

describe("callSessionReducer", () => {
  it("starts a call from no session", () => {
    const next = callSessionReducer(null, { type: "start", input: session("b1") });
    expect(next?.bookingId).toBe("b1");
  });

  it("refuses to start a DIFFERENT booking's call while one is already active", () => {
    const active = session("b1");
    const next = callSessionReducer(active, { type: "start", input: session("b2") });
    // Unchanged — the SAME object, not just an equivalent one, so a caller
    // relying on reference equality (e.g. to skip a re-render) sees no churn.
    expect(next).toBe(active);
  });

  it("refreshes the session for the SAME booking (e.g. a fresh grant on revisit)", () => {
    const active = session("b1", { chatHref: "/chat/b1" });
    const next = callSessionReducer(active, {
      type: "start",
      input: session("b1", { chatHref: "/chat/b1-updated" }),
    });
    expect(next?.chatHref).toBe("/chat/b1-updated");
  });

  it("clears the session on end", () => {
    const active = session("b1");
    expect(callSessionReducer(active, { type: "end" })).toBeNull();
  });

  it("ending an already-empty session is a no-op", () => {
    expect(callSessionReducer(null, { type: "end" })).toBeNull();
  });

  it("frees the floor for a new booking once ended", () => {
    const afterEnd = callSessionReducer(session("b1"), { type: "end" });
    const next = callSessionReducer(afterEnd, { type: "start", input: session("b2") });
    expect(next?.bookingId).toBe("b2");
  });
});
