// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  isClassContentDirty,
  useUnsavedChangesGuard,
  type MaterialDraftSnapshot,
} from "@/lib/use-unsaved-changes-guard";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The unsaved-changes guard hinges entirely on this comparison; the hook
// itself is a thin useEffect/beforeunload wrapper around it. The comparator
// is the shared isMaterialDraftDirty re-exported under its historical name —
// the deep field-by-field cases live in @spiralclass/shared's
// form-validation.test.ts; what's pinned here is the web-visible contract.
describe("isClassContentDirty", () => {
  it("is false when body and source match the last-saved state", () => {
    expect(
      isClassContentDirty({ body: "# Hi", source: "manual" }, { body: "# Hi", source: "manual" }),
    ).toBe(false);
  });

  it("is true when the body diverges", () => {
    expect(
      isClassContentDirty({ body: "# Hi!", source: "manual" }, { body: "# Hi", source: "manual" }),
    ).toBe(true);
  });

  it("is true when only the source diverges (e.g. an AI draft not yet saved)", () => {
    expect(
      isClassContentDirty({ body: "# Hi", source: "ai" }, { body: "# Hi", source: "manual" }),
    ).toBe(true);
  });

  it("is true when only the level diverges", () => {
    const saved = { body: "# Hi", source: "manual", levelId: "l1" };
    expect(isClassContentDirty({ ...saved, levelId: "l2" }, saved)).toBe(true);
  });

  it("is true when only the focus tags diverge", () => {
    const saved = { body: "# Hi", source: "manual", focusTagIds: ["t1"] };
    expect(isClassContentDirty({ ...saved, focusTagIds: ["t1", "t2"] }, saved)).toBe(true);
  });

  it("is false for two untouched empty states", () => {
    expect(
      isClassContentDirty({ body: "", source: "manual" }, { body: "", source: "manual" }),
    ).toBe(false);
  });
});

// Hook-level mount behaviour. The baseline is the FIRST render's snapshot —
// identical to the form's useState initializers by construction — so however
// a caller seeds its fields (existing material or fresh create), the guard
// must never report dirty on mount. A false-dirty here would arm
// `beforeunload` on every navigation away from the library page.
describe("useUnsavedChangesGuard (mount + transitions)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function mount(initial: MaterialDraftSnapshot) {
    const observed: { dirty: boolean | null } = { dirty: null };
    let setDraft: (d: MaterialDraftSnapshot) => void = () => {};
    let savedRef: (s: MaterialDraftSnapshot) => void = () => {};
    function Harness() {
      const [draft, set] = React.useState(initial);
      setDraft = set;
      const { dirty, markSaved } = useUnsavedChangesGuard(draft);
      savedRef = markSaved;
      observed.dirty = dirty;
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(Harness)));
    return {
      observed,
      setDraft: (d: MaterialDraftSnapshot) => act(() => setDraft(d)),
      markSaved: (s: MaterialDraftSnapshot) => act(() => savedRef(s)),
    };
  }

  const existingDraft: MaterialDraftSnapshot = {
    body: "# Saved body",
    source: "ai",
    label: "Lesson",
    levelId: "l1",
    visibility: "at_or_below",
    focusTagIds: ["t1"],
    linkUrl: "https://example.com",
  };
  const createDraft: MaterialDraftSnapshot = {
    body: "",
    source: "manual",
    label: "",
    levelId: "l1", // levels[0] fallback — the classic baseline trap
    visibility: "at_or_below",
    focusTagIds: [],
    linkUrl: "",
  };

  it("is not dirty on mount for an existing material", () => {
    const { observed } = mount(existingDraft);
    expect(observed.dirty).toBe(false);
  });

  it("is not dirty on mount for a fresh create (levels[0]-seeded level)", () => {
    const { observed } = mount(createDraft);
    expect(observed.dirty).toBe(false);
  });

  it("flips dirty on a metadata-only edit and clears on markSaved", () => {
    const { observed, setDraft, markSaved } = mount(existingDraft);
    const edited = { ...existingDraft, levelId: "l2" };
    setDraft(edited);
    expect(observed.dirty).toBe(true);
    markSaved(edited);
    expect(observed.dirty).toBe(false);
  });

  it("stays clean on a pure tag reorder", () => {
    const base = { ...existingDraft, focusTagIds: ["t1", "t2"] };
    const { observed, setDraft } = mount(base);
    setDraft({ ...base, focusTagIds: ["t2", "t1"] });
    expect(observed.dirty).toBe(false);
  });
});
