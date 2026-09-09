import { describe, expect, it } from "vitest";
import type { CallMaterial } from "@spiralclass/shared";
import {
  initialMaterialsTab,
  rendersInCall,
  shouldShowMaterialsControl,
} from "@/components/video/call-materials-panel";

// Permission-shaped decisions extracted from CallMaterialsPanel (the in-call
// Materials button/sheet): who gets the control at all, and which tab opens
// first. Pinned here without rendering — see call-materials-panel.tsx for the
// full teacher-vs-student wiring (canBrowseLibrary is only ever passed true
// from the teacher call page).

describe("shouldShowMaterialsControl", () => {
  it("hides the control when there are no class materials and the caller can't browse the library (student, empty class)", () => {
    expect(shouldShowMaterialsControl(0, false)).toBe(false);
  });

  it("shows the control when the class has materials, regardless of library access (student, non-empty class)", () => {
    expect(shouldShowMaterialsControl(3, false)).toBe(true);
  });

  it("shows the control for a teacher with an empty class list, because she can still browse her library", () => {
    expect(shouldShowMaterialsControl(0, true)).toBe(true);
  });

  it("shows the control for a teacher with both class materials and library access", () => {
    expect(shouldShowMaterialsControl(2, true)).toBe(true);
  });
});

describe("initialMaterialsTab", () => {
  it("defaults to the class tab when the class already has materials", () => {
    expect(initialMaterialsTab(1)).toBe("class");
  });

  it("defaults to the library tab when the class has nothing attached yet", () => {
    expect(initialMaterialsTab(0)).toBe("library");
  });
});

// One answer, three consequences: whether the row says "opens outside the
// call", whether a pick lands in the in-call viewer or a browser tab, and
// whether the teacher is offered "for the student"/"for both" at all — a
// material she cannot be shown must never be offered to be shown to her.
describe("rendersInCall", () => {
  const m = (over: Partial<CallMaterial>): CallMaterial => ({
    id: "m1",
    label: "Worksheet",
    kind: "file",
    body: null,
    viewUrl: "https://x/y",
    fileKind: "other",
    ...over,
  });

  it("renders a native content material, which is what it always did", () => {
    expect(rendersInCall(m({ kind: "content", body: "# Hi", viewUrl: null, fileKind: null }))).toBe(
      true,
    );
  });

  it("renders an attached PDF or image in the call — the point of this change", () => {
    expect(rendersInCall(m({ fileKind: "pdf" }))).toBe(true);
    expect(rendersInCall(m({ fileKind: "image" }))).toBe(true);
  });

  it("sends a file with no in-page renderer out to a tab, as before", () => {
    expect(rendersInCall(m({ fileKind: "other" }))).toBe(false);
  });

  it("never renders an external link, whatever its URL ends in", () => {
    expect(rendersInCall(m({ kind: "link", fileKind: null, viewUrl: "https://x/y.pdf" }))).toBe(
      false,
    );
  });

  it("falls back to opening externally when fileKind is absent (an older sender's packet)", () => {
    expect(rendersInCall(m({ fileKind: null }))).toBe(false);
  });

  it("refuses a file with no URL to render, rather than opening an empty viewer", () => {
    expect(rendersInCall(m({ fileKind: "pdf", viewUrl: null }))).toBe(false);
  });
});
