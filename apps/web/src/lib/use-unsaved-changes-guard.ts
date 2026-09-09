import { useCallback, useEffect, useRef, useState } from "react";
import { isMaterialDraftDirty, type MaterialDraftSnapshot } from "@spiralclass/shared";

// Unsaved-changes guard for the material editor. The editor holds AI drafts
// and hand-edits that would otherwise silently vanish on tab close/refresh.
// Scope: `beforeunload` (tab close/refresh/navigate-away) plus a visible
// "dirty" flag for an in-page indicator. Next.js App Router has no built-in
// API to block in-app <Link>/router navigation short of wrapping every
// navigation trigger, which is disproportionate for a Tier 1 UX affordance —
// beforeunload covers the case that actually loses work.
//
// The comparison itself lives in @spiralclass/shared (isMaterialDraftDirty),
// shared with mobile's MaterialForm so the two platforms can't disagree about
// what counts as an unsaved edit.

// Kept under its historical name so existing tests/imports stay valid — the
// shared comparator's {body, source} subset is exactly the old signature.
export const isClassContentDirty = isMaterialDraftDirty;
export type { MaterialDraftSnapshot };

// Serialize to a scalar so the effect below can depend on VALUE, not identity
// — `focusTagIds` is a fresh array every render, and sorting keeps a pure
// reorder (which the comparator ignores) from re-running the effect.
function draftKey(s: MaterialDraftSnapshot): string {
  return JSON.stringify([
    s.body,
    s.source,
    s.label ?? "",
    s.levelId ?? "",
    s.visibility ?? "",
    [...(s.focusTagIds ?? [])].sort(),
    s.linkUrl ?? "",
  ]);
}

/**
 * The baseline is the FIRST render's draft — by construction identical to the
 * form's useState initializers, so the guard can never report dirty on mount
 * however the caller seeds its fields. `markSaved` replaces the baseline
 * after a successful save (or a revision restore).
 */
export function useUnsavedChangesGuard(draft: MaterialDraftSnapshot): {
  dirty: boolean;
  markSaved: (saved: MaterialDraftSnapshot) => void;
} {
  const lastSaved = useRef<MaterialDraftSnapshot | null>(null);
  if (lastSaved.current === null) lastSaved.current = draft;
  const [dirty, setDirty] = useState(false);

  const key = draftKey(draft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    setDirty(isMaterialDraftDirty(draftRef.current, lastSaved.current!));
  }, [key]);

  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      // Chrome requires returnValue to be set to show the native prompt.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Stable identity (useCallback) so effects that call it can list it as a
  // dependency without re-running on every render.
  const markSaved = useCallback((saved: MaterialDraftSnapshot) => {
    lastSaved.current = saved;
    setDirty(false);
  }, []);

  return { dirty, markSaved };
}
