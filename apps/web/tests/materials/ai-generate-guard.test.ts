// @vitest-environment jsdom
//
// Pre-generate guard for the "Generate with AI" sub-flow: mirrors the server
// rule in prepareLibraryMaterialPrompt (lib/materials/handlers.ts) so the
// client never lets a request through that the server would 422 — a topic OR
// at least one focus tag is required; a template alone is NOT enough (the
// server ignores templateId for this check), so the guard must not treat it
// as satisfying either.
//
// The Generate button itself is NEVER disabled by this guard (canonical form
// pattern, same as manual-create-form.tsx / material-form.tsx): a disabled
// button never fires a click, so clicking with nothing filled in produced no
// visible reaction at all — reading as "no validation happened." The guard
// now runs on submit and surfaces a FieldError instead.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

const { renderPreview, renderEditor } = vi.hoisted(() => ({
  renderPreview: vi.fn(),
  renderEditor: vi.fn(),
}));

vi.mock("@/components/class-content/class-content-markdown", () => ({
  ClassContentMarkdown: ({ body }: { body: string }) => {
    renderPreview(body);
    return null;
  },
}));

vi.mock("@/components/materials/material-editor", () => ({
  MaterialEditor: ({ body }: { body: string }) => {
    renderEditor(body);
    return null;
  },
}));

vi.mock("@/app/actions/library", () => ({
  refineMaterialDraftAction: vi.fn(),
  saveMaterialContentAction: vi.fn(),
  restoreMaterialRevisionAction: vi.fn(),
  getMaterialPodcastStatusAction: vi.fn(),
  saveContentToLibraryAction: vi.fn(),
  generateMaterialDraftAction: vi.fn(),
  generateMaterialPodcastAction: vi.fn(),
  snapshotRefineCheckpointAction: vi.fn(),
}));
vi.mock("@/app/actions/class-content", () => ({
  saveClassContentTemplateAction: vi.fn(),
  deleteClassContentTemplateAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "es",
}));

const { MaterialForm } = await import("@/components/materials/material-form");
const { canGenerateMaterial, AiGenerateFlow } =
  await import("@/components/materials/ai-generate-flow");

describe("canGenerateMaterial (pure guard logic)", () => {
  it("is false with no topic and no focus tags", () => {
    expect(canGenerateMaterial("", 0)).toBe(false);
    expect(canGenerateMaterial("   ", 0)).toBe(false);
  });

  it("is true with a non-blank topic alone", () => {
    expect(canGenerateMaterial("Past tense", 0)).toBe(true);
  });

  it("is true with at least one focus tag alone", () => {
    expect(canGenerateMaterial("", 1)).toBe(true);
  });

  it("a template selection alone is not modeled here — only topic/tags satisfy it", () => {
    // The guard's signature doesn't even take a templateId — selecting a
    // template can never flip this true, matching the server's
    // prepareLibraryMaterialPrompt, which also ignores templateId for this
    // check.
    expect(canGenerateMaterial("", 0)).toBe(false);
  });
});

describe("AiGenerateFlow — Describe step Generate button", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderFlow() {
    act(() => {
      root.render(
        React.createElement(AiGenerateFlow, {
          levels: [],
          focusGroups: [],
          templates: [],
          isPro: true,
          onSaved: vi.fn(),
        }),
      );
    });
  }

  function generateButton(): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("classContent.author.generate"),
    );
    if (!btn) throw new Error("Generate button not found");
    return btn as HTMLButtonElement;
  }

  function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitForm() {
    const form = container.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("keeps Generate enabled (so a click is always felt) even with an empty topic", () => {
    renderFlow();
    expect(generateButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("web.materials.guardHint");
  });

  it("submitting with nothing filled in shows the guard message instead of silently doing nothing", () => {
    renderFlow();
    submitForm();
    expect(container.textContent).toContain("web.materials.guardHint");
  });

  it("typing a topic then submitting clears the guard message and doesn't reject", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    renderFlow();
    submitForm();
    expect(container.textContent).toContain("web.materials.guardHint");

    const topicInput = container.querySelector<HTMLInputElement>("#ai-topic")!;
    act(() => typeInto(topicInput, "Past tense with food verbs"));
    submitForm();

    expect(container.textContent).not.toContain("web.materials.guardHint");
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("keeps the generated preview out of title and instruction keystrokes", async () => {
    const body = "# Generated material";
    const stream = `data: ${JSON.stringify(body)}\n\ndata: ${JSON.stringify("\u001f")}\n\n`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    try {
      renderFlow();
      act(() => typeInto(container.querySelector<HTMLInputElement>("#ai-topic")!, "Verbs"));
      await act(async () => submitForm());
      expect(renderPreview).toHaveBeenLastCalledWith(body);
      renderPreview.mockClear();

      act(() =>
        typeInto(
          container.querySelector<HTMLInputElement>("#ai-refine-instruction")!,
          "Add examples",
        ),
      );
      act(() =>
        typeInto(container.querySelector<HTMLInputElement>("#ai-review-label")!, "Verb practice"),
      );

      expect(renderPreview).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps the document editor out of name keystrokes in a saved material", () => {
    const body = "# Saved material";
    act(() => {
      root.render(
        React.createElement(MaterialForm, {
          scope: "library",
          levels: [{ id: "l1", label: "A1" }],
          aiEnabled: true,
          isPro: true,
          existing: {
            id: "m1",
            levelId: "l1",
            visibility: "at_or_below",
            label: "Original name",
            body,
            source: "ai",
            focusTagIds: [],
          },
        }),
      );
    });
    expect(renderEditor).toHaveBeenLastCalledWith(body);
    renderEditor.mockClear();

    const input = container.querySelector<HTMLInputElement>("#content-label")!;
    act(() => typeInto(input, "Updated name"));

    expect(input.value).toBe("Updated name");
    expect(renderEditor).not.toHaveBeenCalled();
  });
});
