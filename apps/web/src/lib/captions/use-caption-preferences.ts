"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CAPTION_PREFERENCES_STORAGE_KEY,
  DEFAULT_CAPTION_PREFERENCES,
  parseCaptionPreferences,
  type CaptionPreferences,
} from "./preferences";

// React + localStorage wiring for the reader's subtitle preferences. The
// decisions (what a valid preference is, what the defaults are, how a
// malformed stored blob degrades) all live in preferences.ts, which is pure
// and unit-tested; this file is only the browser plumbing.

export function useCaptionPreferences(): {
  prefs: CaptionPreferences;
  setPrefs: (patch: Partial<CaptionPreferences>) => void;
} {
  // Starts at the defaults on BOTH server and first client render, then
  // hydrates from storage in an effect. Reading localStorage during render
  // would make the two disagree and produce a hydration mismatch on the one
  // surface that can least afford a remount — the call is mid-connection at
  // that moment.
  const [prefs, setState] = useState<CaptionPreferences>(DEFAULT_CAPTION_PREFERENCES);

  useEffect(() => {
    try {
      setState(
        parseCaptionPreferences(window.localStorage.getItem(CAPTION_PREFERENCES_STORAGE_KEY)),
      );
    } catch {
      /* private mode / storage disabled — the defaults are already correct */
    }
  }, []);

  const setPrefs = useCallback((patch: Partial<CaptionPreferences>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(CAPTION_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage disabled — the preference still applies for this session */
      }
      return next;
    });
  }, []);

  return { prefs, setPrefs };
}
