import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// "Edit with AI" (D-73) — the unified MaterialForm no longer offers a single
// raw-Markdown textarea bound to the WHOLE body; MATERIAL_EDITING phase 4
// restored direct text editing, but per block, through the section/block
// editor (material-editor.tsx / block-editor.tsx) — so a paragraph's own
// textarea holds just that block's text, never the full stored Markdown
// verbatim. These SSR checks pin that shape and the AI-off fallback that
// keeps a single raw textarea as the only authoring path when there's no AI.

// The form pulls server actions (which reach prisma/server-only) and the locale
// provider — stub both so the client component renders in isolation.
vi.mock("@/app/actions/library", () => ({
  generateMaterialDraftAction: vi.fn(),
  refineMaterialDraftAction: vi.fn(),
  restoreMaterialRevisionAction: vi.fn(),
  saveContentToLibraryAction: vi.fn(),
  saveMaterialContentAction: vi.fn(),
  generateMaterialPodcastAction: vi.fn(),
  getMaterialPodcastStatusAction: vi.fn(),
  snapshotRefineCheckpointAction: vi.fn(),
}));
vi.mock("@/app/actions/class-content", () => ({
  saveClassContentTemplateAction: vi.fn(),
  deleteClassContentTemplateAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "es-MX",
}));
vi.mock("@/components/subscriptions/pro-lock-note", () => ({
  ProLockNote: ({ message }: { message: string }) => React.createElement("p", null, message),
}));

const { MaterialForm } = await import("@/components/materials/material-form");
type ContinuationCandidate = {
  materialId: string;
  bookingId: string;
  label: string | null;
  scheduledStart: string;
  preview: string;
};

const existing = {
  id: "m1",
  body: "# Hello\n\nSaved content",
  source: "manual" as const,
  label: "Doc",
  levelId: "l1",
  visibility: "at_or_below",
  focusTagIds: [] as string[],
};
const levels = [{ id: "l1", label: "A1" }];

function renderForm(aiEnabled: boolean, withExisting = true, isPro = true) {
  return renderToStaticMarkup(
    React.createElement(MaterialForm, {
      scope: "library" as const,
      levels,
      focusGroups: [],
      templates: [],
      revisions: [],
      aiEnabled,
      isPro,
      existing: withExisting ? existing : undefined,
    }),
  );
}

describe("MaterialForm — Edit with AI (D-73)", () => {
  it("renders the body preview-first (no open editors) when AI is on", () => {
    const html = renderForm(true);
    // Preview-first (Phase 5): the body renders exactly as the student sees
    // it — no textarea at all until a block is tapped, and never the raw
    // stored Markdown verbatim.
    expect(html).not.toContain("# Hello\n\nSaved content<");
    expect(html).not.toContain("<textarea");
    expect(html).toContain(">Saved content<");
    expect(html).toContain('aria-label="material.editor.block.editThis"');
    // The body still posts with the save form via a hidden field.
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="body"');
    // Both the per-section and whole-document "Edit with AI" controls stay
    // available alongside direct editing.
    expect(html).toContain("material.editor.refineSection");
    expect(html).toContain("classContent.author.editWithAi");
    expect(html).toContain("classContent.author.refineInstructionPlaceholder");
  });

  it("keeps a raw-Markdown textarea as the fallback when AI is not configured", () => {
    const html = renderForm(false);
    expect(html).toContain("<textarea");
    expect(html).not.toContain("classContent.author.editWithAi");
  });
});

// Bug fix: the "Generate"/"Edit with AI" controls used to be enabled for
// every teacher whenever the platform had AI creds configured (`aiEnabled`),
// regardless of plan — a Free teacher could submit and only learn it was
// Pro-only after the server rejected it. `isPro` now disables those controls
// proactively and explains why, mirroring the server's gateProFeature check.
describe("MaterialForm — Pro-gated AI controls (proactive, not reactive)", () => {
  it("disables Edit with AI for a Free teacher and explains why, instead of letting the request fail after submit", () => {
    const proHtml = renderForm(true, true, true);
    const freeHtml = renderForm(true, true, false);
    expect(freeHtml).toContain("classContent.author.editWithAi");
    expect(freeHtml).toContain("classContent.author.proRequired");
    // The refine button is disabled either way with an empty instruction
    // (canonical form pattern), but a Free render additionally disables the
    // "generate fresh content" button, which the Pro render never disables —
    // a strictly higher disabled-button count is the plan gate taking effect.
    const disabledCount = (html: string) => (html.match(/disabled=""/g) ?? []).length;
    expect(disabledCount(freeHtml)).toBeGreaterThan(disabledCount(proHtml));
  });

  it("leaves the AI controls enabled for a Pro teacher", () => {
    const html = renderForm(true, true, true);
    expect(html).not.toContain("classContent.author.proRequired");
  });
});

// The disclosure header button whose visible title is `titleKey` — returns
// its aria-expanded state, or null if no such header rendered. The gap
// matcher refuses to cross </button>, so the title must sit INSIDE this
// button — a later occurrence of the key (e.g. the generate form's own
// submit button text) can never be attributed to an earlier header.
function headerExpanded(html: string, titleKey: string): boolean | null {
  const m = html.match(
    new RegExp(
      `<button[^>]*aria-expanded="(true|false)"[^>]*>(?:<(?!/button)[^>]*>|[^<])*?${titleKey}`,
    ),
  );
  return m ? m[1] === "true" : null;
}

describe("MaterialForm — section collapse defaults", () => {
  it("keeps the content section OPEN when editing (preview-first made it short)", () => {
    const html = renderForm(true, true);
    // The body used to collapse when editing so Save stayed reachable — the
    // pinned bar fixed that, so the content the teacher came to edit opens.
    expect(headerExpanded(html, "web.dashboard.classes.classContent.contentMarkdown")).toBe(true);
    expect(html).toContain('name="body"');
    expect(html).toContain("classContent.author.editWithAi");
  });

  it("collapses the AI-generate section when editing, opens it on create", () => {
    expect(headerExpanded(renderForm(true, true), "classContent.author.createWithAi")).toBe(false);
    expect(headerExpanded(renderForm(true, false), "classContent.author.createWithAi")).toBe(true);
  });

  it("keeps collapsed sections' fields in the DOM (hidden, not unmounted) so they still post", () => {
    const html = renderForm(true, true);
    // The attach cluster starts collapsed on a link-less existing material…
    expect(html).toContain("materials.attachmentsSection");
    // …but its inputs still render (hidden) inside the save form.
    expect(html).toContain('name="linkUrl"');
    expect(html).toContain('name="file"');
  });
});

describe("MaterialForm — pinned action bar (external submitter)", () => {
  it("gives the save form an id and the bar button a matching form=, after </form>", () => {
    const html = renderForm(true, true);
    const formIdMatch = html.match(/<form[^>]*id="(material-save-[^"]+)"/);
    expect(formIdMatch).toBeTruthy();
    const formId = formIdMatch![1];
    const buttonIdx = html.indexOf(`form="${formId}"`);
    expect(buttonIdx).toBeGreaterThan(-1);
    // The submitter lives OUTSIDE the form it submits — after its close tag.
    const formOpenIdx = html.indexOf(formIdMatch![0]);
    const formCloseIdx = html.indexOf("</form>", formOpenIdx);
    expect(buttonIdx).toBeGreaterThan(formCloseIdx);
    // The bar itself is labeled for AT.
    expect(html).toContain("classContent.author.actionsLabel");
  });

  it("mints a different form id per mounted instance (library list mounts many)", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        React.createElement(MaterialForm, {
          scope: "library" as const,
          levels,
          focusGroups: [],
          templates: [],
          revisions: [],
          aiEnabled: true,
          isPro: true,
          existing,
        }),
        React.createElement(MaterialForm, {
          scope: "library" as const,
          levels,
          focusGroups: [],
          templates: [],
          revisions: [],
          aiEnabled: true,
          isPro: true,
          existing,
        }),
      ),
    );
    const ids = [...html.matchAll(/<form[^>]*id="(material-save-[^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("MaterialForm — tags live in the save form; gen-level is gone", () => {
  const focusGroups = [
    {
      categoryId: "c1",
      categoryLabel: "Grammar",
      tags: [{ id: "t1", label: "Past tense" }],
    },
  ];

  it("renders the tag picker between visibility and the body, not inside the generate form", () => {
    const html = renderToStaticMarkup(
      React.createElement(MaterialForm, {
        scope: "library" as const,
        levels,
        focusGroups,
        templates: [],
        revisions: [],
        aiEnabled: true,
        isPro: true,
        existing,
      }),
    );
    const visibilityIdx = html.indexOf('id="content-visibility"');
    const tagsIdx = html.indexOf("libManage.tags");
    const bodyIdx = html.indexOf('name="body"');
    expect(visibilityIdx).toBeGreaterThan(-1);
    expect(tagsIdx).toBeGreaterThan(visibilityIdx);
    expect(bodyIdx).toBeGreaterThan(tagsIdx);
    // The duplicate level Select inside the generate form is deleted — the
    // hidden levelId input still posts the save form's value there.
    expect(html).not.toContain('id="gen-level"');
  });
});

// Regression for the reported bug: a fresh, empty material form used to render
// its "Add material" submit button DISABLED (`disabled={… || !canSave}`), so
// pressing it did nothing and never explained why. The canonical form pattern
// keeps the button enabled and validates on submit, surfacing inline per-field
// errors instead. SSR can't fire the onSubmit handler, but it can prove the
// button is no longer disabled on an empty form.
// Lesson continuity ("continue from a previous class"): the AI generate form
// on the booking scope offers a checkbox picker over this student's other
// classes with body-bearing content.
describe("MaterialForm — continue from a previous class (booking scope)", () => {
  function renderBookingForm(continuationCandidates: ContinuationCandidate[]) {
    return renderToStaticMarkup(
      React.createElement(MaterialForm, {
        scope: "booking" as const,
        bookingId: "b1",
        levels: [],
        focusGroups: [],
        templates: [],
        revisions: [],
        continuationCandidates,
        aiEnabled: true,
        isPro: true,
      }),
    );
  }

  it("renders a checkbox row per candidate, labeled and previewed", () => {
    const html = renderBookingForm([
      {
        materialId: "m-prev",
        bookingId: "b-prev",
        label: "Greetings",
        scheduledStart: "2026-07-10T15:00:00.000Z",
        preview: "We covered hola and buenos días.",
      },
    ]);
    expect(html).toContain("classContent.author.continueFromLabel");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Greetings");
    expect(html).toContain("We covered hola and buenos días.");
  });

  it("omits the picker entirely when there are no candidates", () => {
    const html = renderBookingForm([]);
    expect(html).not.toContain("classContent.author.continueFromLabel");
  });

  it("never renders the picker on the library scope, even if candidates were passed", () => {
    const html = renderToStaticMarkup(
      React.createElement(MaterialForm, {
        scope: "library" as const,
        levels,
        focusGroups: [],
        templates: [],
        revisions: [],
        aiEnabled: true,
        isPro: true,
      }),
    );
    expect(html).not.toContain("classContent.author.continueFromLabel");
  });
});

// Data-loss regression: the save action reads a present-but-empty `linkUrl`
// field as "clear it", and the form always renders the link input — so a form
// that doesn't seed the input from the stored value deletes the material's
// link on every save. Editing a booking material used to do exactly that.
describe("MaterialForm — existing link round-trips into the link input", () => {
  it("seeds the link input with the stored linkUrl when editing", () => {
    const html = renderToStaticMarkup(
      React.createElement(MaterialForm, {
        scope: "library" as const,
        levels,
        focusGroups: [],
        templates: [],
        revisions: [],
        aiEnabled: true,
        isPro: true,
        existing: { ...existing, linkUrl: "https://example.com/worksheet" },
      }),
    );
    expect(html).toContain('value="https://example.com/worksheet"');
  });
});

describe("MaterialForm — submit button stays enabled (validate on submit)", () => {
  function renderFresh(aiEnabled: boolean, isPro = true) {
    return renderToStaticMarkup(
      React.createElement(MaterialForm, {
        scope: "library" as const,
        levels,
        focusGroups: [],
        templates: [],
        revisions: [],
        aiEnabled,
        isPro,
      }),
    );
  }

  it("renders the add-material button enabled even with nothing filled in", () => {
    const html = renderFresh(false);
    // The button is present…
    expect(html).toContain("web.materials.addMaterial");
    // …and not disabled. Button's own Tailwind classes always contain the
    // substring "disabled" (the disabled: variant), so check for the actual
    // boolean attribute SSR renders (`disabled=""`) rather than the substring.
    expect(html).not.toContain('disabled=""');
  });
});

// AI-editing UX follow-up: Version History used to show only a timestamp and
// a 60-char text snippet, with no way to tell which row undoes an AI change
// versus a manual edit without opening each one. Each row now carries a
// source badge, using data the query already returned.
describe("MaterialForm — Version History shows which revisions were AI edits", () => {
  function renderWithRevisions() {
    return renderToStaticMarkup(
      React.createElement(MaterialForm, {
        scope: "library" as const,
        levels,
        focusGroups: [],
        templates: [],
        revisions: [
          { id: "r-ai", body: "# AI draft", source: "ai" as const, createdAt: new Date() },
          {
            id: "r-manual",
            body: "# Hand-edited",
            source: "manual" as const,
            createdAt: new Date(),
          },
        ],
        aiEnabled: true,
        isPro: true,
        existing,
      }),
    );
  }

  it("labels an AI-sourced revision distinctly from a manual one", () => {
    const html = renderWithRevisions();
    expect(html).toContain("classContent.author.revisionSourceAi");
    expect(html).toContain("classContent.author.revisionSourceManual");
  });

  it("still shows every revision's Restore control regardless of source", () => {
    const html = renderWithRevisions();
    expect(html.match(/classContent\.author\.restore</g)?.length).toBe(2);
  });
});

// No AI change has happened yet on a fresh render, so neither the whole-
// document "Undo AI change" banner nor its checkpoint-only state should leak
// into the initial markup — same regression class as the empty-form tests
// above (a stray affordance with nothing to act on is worse than none).
describe("MaterialForm — whole-document AI-change banner starts hidden", () => {
  it("renders no 'Undo AI change' affordance until a refine has actually applied", () => {
    const html = renderForm(true, true, true);
    expect(html).not.toContain("classContent.author.aiChangeApplied");
    expect(html).not.toContain("material.editor.undoAiChange");
  });
});
