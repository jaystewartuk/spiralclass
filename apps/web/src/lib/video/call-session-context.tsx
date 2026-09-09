"use client";

import { createContext, useCallback, useContext, useMemo, useReducer } from "react";
import { callSessionReducer, type CallSessionInput } from "@/lib/video/call-session-reducer";

export type { CallSessionInput };

// WHATSAPP_VIDEO_UX (cross-navigation persistence): the call used to live and
// die with the /dashboard/classes/[id]/call (or /my-classes/[id]/call) PAGE —
// <ClassCall> connected on mount and disconnected on unmount, so navigating
// anywhere else in the app hung up the call. That's what made "minimize" only
// ever an in-page bubble: the call route was the only place the call could
// exist at all.
//
// This context moves the call OUT of page lifecycle and into a session held
// here, at the app root (see CallSessionOverlay, rendered once from
// app/layout.tsx). A call page's only job now is to mint a token and hand it
// to `startCall` — the actual <ClassCall> renders from the root overlay,
// which isn't affected by route changes, so navigating to chat (or anywhere
// else) no longer tears the connection down. ClassCall's OWN minimize/drag/
// swap logic is untouched by this — it already renders through a
// document.body portal; the only thing that changes is WHO mounts it.
//
// The actual start/end transition logic (including the "refuse to swap
// booking mid-call" rule) is callSessionReducer, in the sibling .ts module —
// unit-tested there since this repo's unit suite doesn't reach into .tsx
// view components (see vitest.config.ts's coverage comment). This file is
// just the thin React wiring around it.
type CallSessionContextValue = {
  session: CallSessionInput | null;
  startCall: (input: CallSessionInput) => void;
  endCall: () => void;
  isActiveFor: (bookingId: string) => boolean;
};

const CallSessionContext = createContext<CallSessionContextValue | null>(null);

export function CallSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, dispatch] = useReducer(callSessionReducer, null);

  const startCall = useCallback(
    (input: CallSessionInput) => dispatch({ type: "start", input }),
    [],
  );
  const endCall = useCallback(() => dispatch({ type: "end" }), []);
  const isActiveFor = useCallback(
    (bookingId: string) => session?.bookingId === bookingId,
    [session],
  );

  const value = useMemo(
    () => ({ session, startCall, endCall, isActiveFor }),
    [session, startCall, endCall, isActiveFor],
  );

  return <CallSessionContext.Provider value={value}>{children}</CallSessionContext.Provider>;
}

export function useCallSession(): CallSessionContextValue {
  const ctx = useContext(CallSessionContext);
  if (!ctx) throw new Error("useCallSession must be used within a CallSessionProvider");
  return ctx;
}
