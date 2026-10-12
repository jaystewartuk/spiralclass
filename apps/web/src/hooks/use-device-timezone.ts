"use client";

import { useSyncExternalStore } from "react";

// The IANA zone this browser is in, or null on the server and wherever the
// engine will not say. Read as an external store rather than set from an
// effect: the zone is a fact about the device, not state this component owns,
// and the server snapshot (null) keeps the first client render identical to
// the server's markup.

const neverChanges = () => () => {};

function readDeviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function useDeviceTimezone(enabled = true): string | null {
  return useSyncExternalStore(
    neverChanges,
    () => (enabled ? readDeviceTimezone() : null),
    () => null,
  );
}
