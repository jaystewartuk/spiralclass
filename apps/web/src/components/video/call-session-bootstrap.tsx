"use client";

import { useEffect, useRef } from "react";
import { useCallSession, type CallSessionInput } from "@/lib/video/call-session-context";

// Rendered by the call page (server component) instead of <ClassCallClient>
// directly. Its only job is to hand the freshly-minted grant to the root-level
// session (see call-session-context.tsx) on mount — the actual call UI renders
// from CallSessionOverlay in app/layout.tsx, not from here, so this page can
// safely unmount (navigating away) without taking the call down with it.
export function CallSessionBootstrap(props: CallSessionInput) {
  const { startCall } = useCallSession();

  // A ref, not a dependency: `props` carries a fresh grant/overlay on every
  // server render of this page, and re-running the effect below on every
  // prop change would fight the "reconnect only on retry" rule ClassCall's
  // own connection effect already enforces (callConnectionKey). One call per
  // page VISIT (mount) is the right cadence — a revisit after navigating away
  // re-mounts this component and calls startCall again, which is exactly the
  // one case a fresh grant is wanted. `startCall` itself is a stable
  // useCallback reference (call-session-context.tsx), so it's the only
  // genuinely reactive dependency here.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    startCall(propsRef.current);
  }, [startCall]);

  return null;
}
