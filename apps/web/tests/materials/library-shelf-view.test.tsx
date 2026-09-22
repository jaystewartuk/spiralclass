import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// The two server-rendered halves of a materials shelf — the toolbar above the
// list and one row inside it.
//
// These pin the properties the redesign rests on, none of which the type system
// or a screenshot can hold:
//
//   * the LEVEL row is navigation, not a filter — so it sits outside the filter
//     panel, its "All" carries the ALL_LEVELS sentinel rather than dropping the
//     param, and it is not counted by "clear filters";
//   * every chip group is a labelled `role="group"` and the selected chip says
//     so with `aria-current`, rather than being distinguished by fill alone;
//   * a row states its KIND in text, not only as an icon.

vi.mock("@/lib/i18n", () => ({
  // The real English catalog, so a wrong or missing key shows up as the raw key
  // in the markup rather than passing silently.
  getT: async () => createT("en"),
}));
// The inline editors drag the whole MaterialForm tree (and its actions) into a
// view test; the row's own layout is what is under test here.
vi.mock("@/app/(app)/dashboard/materials/edit-form", () => ({
  LibraryEditForm: () => React.createElement("button", null, "edit"),
}));
vi.mock("@/app/(app)/dashboard/materials/content-edit-form", () => ({
  LibraryContentEditForm: () => React.createElement("button", null, "edit"),
}));
vi.mock("@/app/(app)/dashboard/materials/delete-material-button", () => ({
  DeleteMaterialButton: () => React.createElement("button", null, "delete"),
}));
vi.mock("@/app/actions/library", () => ({ setLibraryMaterialArchivedAction: async () => {} }));
// A client Select bound to next/navigation's router, which has no app router to
// mount in a server-render test. The sort control is unchanged by this work.
vi.mock("@/app/(app)/dashboard/materials/materials-sort", () => ({
  MaterialsSort: () => React.createElement("div", null, "sort"),
}));

const { LibraryToolbar } = await import("@/app/(app)/dashboard/materials/library-toolbar");
const { MaterialCard } = await import("@/app/(app)/dashboard/materials/material-card");
const { ALL_LEVELS } = await import("@spiralclass/shared");

const LEVELS = [
  { id: "lvl-a1", code: "A1", label: "A1", position: 1 },
  { id: "lvl-a2", code: "A2", label: "A2", position: 2 },
];

// The href of the <a> whose text contains `label`. Read backwards from the
// label rather than by a spanning regex: a `href="…"[^]*?label` pattern matches
// from the FIRST href in the document, not the nearest one.
function hrefOfLinkTo(html: string, label: string): string {
  const at = html.indexOf(label);
  expect(at, `no link labelled ${label}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<a ", at);
  const href = html.slice(open, at).match(/href="([^"]*)"/)?.[1];
  expect(href).toBeDefined();
  // renderToStaticMarkup escapes the param separators.
  return href!.replace(/&amp;/g, "&");
}

const visibilityLabel = (v: string) =>
  v === "all" ? "Everyone" : v === "exact" ? "Only this level" : "This level & below";

async function renderToolbar(over: Partial<Parameters<typeof LibraryToolbar>[0]> = {}) {
  return renderToStaticMarkup(
    await LibraryToolbar({
      urlState: {
        level: "lvl-a2",
        category: null,
        type: null,
        visibility: null,
        q: "",
        sort: "recent",
        view: "active",
      },
      levels: LEVELS,
      focusGroups: [],
      activeLevel: "lvl-a2",
      activeCategory: null,
      activeType: null,
      activeVisibility: null,
      activeFilterCount: 0,
      visibilityLabel,
      archivedCount: 0,
      total: 7,
      showFilters: true,
      ...over,
    }),
  );
}

describe("LibraryToolbar", () => {
  it("marks the shelf she is on with aria-current, not just a fill", () => {
    return renderToolbar().then((html) => {
      const chips = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(A1|A2)</g)];
      expect(chips.length).toBe(2);
      const a2 = html.match(/<a[^>]*aria-current="true"[^>]*>A2</);
      expect(a2).not.toBeNull();
      expect(html).not.toMatch(/<a[^>]*aria-current="true"[^>]*>A1</);
    });
  });

  it("points the level row's All at the ALL_LEVELS sentinel, never at a dropped param", () => {
    // A dropped `level` means "go back to the hub" — clicking All inside a
    // shelf must widen the list, not eject her to the picker.
    return renderToolbar().then((html) => {
      expect(html).toContain(`level=${ALL_LEVELS}`);
    });
  });

  it("labels every chip group, so the chips are not announced as loose links", () => {
    return renderToolbar().then((html) => {
      for (const id of ["materials-filter-type", "materials-filter-visibility"]) {
        expect(html).toContain(`aria-labelledby="${id}"`);
        expect(html).toContain(`id="${id}"`);
      }
      // The level row is navigation, so it is labelled directly rather than by
      // a caption that would make it read as a fourth filter...
      expect(html).toContain('aria-label="Level"');
      // ...and the active/archived pair is a third thing again: a shelf, not a
      // filter and not a level.
      expect(html).toContain('aria-label="Shelf"');
    });
  });

  it("puts the result count where the decision to narrow is made, and announces it", () => {
    return renderToolbar({ total: 7 }).then((html) => {
      expect(html).toContain("7 materials");
      expect(html).toContain('aria-live="polite"');
    });
  });

  it("pluralises the count rather than saying '1 materials'", () => {
    return renderToolbar({ total: 1 }).then((html) => {
      expect(html).toContain("1 material");
      expect(html).not.toContain("1 materials");
    });
  });

  it("hides the category row entirely when the teacher has no focus tags", () => {
    return renderToolbar().then((html) => {
      expect(html).not.toContain("materials-filter-category");
    });
  });

  it("offers no clear-filters link when nothing is narrowing the shelf", () => {
    return renderToolbar({ activeFilterCount: 0 }).then((html) => {
      expect(html).not.toContain("Clear filters");
    });
  });

  it("clears the narrowing axes but keeps the shelf and the sort", () => {
    return renderToolbar({
      urlState: {
        level: "lvl-a2",
        category: null,
        type: "file",
        visibility: "exact",
        q: "verbs",
        sort: "name",
        view: "archived",
      },
      activeType: "file",
      activeVisibility: "exact",
      activeFilterCount: 3,
    }).then((html) => {
      expect(html).toContain("Clear filters");
      expect(html).toContain("(3 filters)");
      const params = new URL(hrefOfLinkTo(html, "Clear filters"), "https://x.test").searchParams;
      expect(params.get("type")).toBeNull();
      expect(params.get("visibility")).toBeNull();
      expect(params.get("q")).toBeNull();
      expect(params.get("level")).toBe("lvl-a2");
      expect(params.get("view")).toBe("archived");
      expect(params.get("sort")).toBe("name");
    });
  });

  it("keeps the shelf navigation when the library is empty, so the hub is still reachable", async () => {
    // Gating the whole toolbar on a non-empty library once left a teacher who
    // opened a level from an empty library with no way back but browser Back.
    const html = await renderToolbar({ showFilters: false, total: 0 });
    expect(html).toContain("All levels");
    expect(html).toContain(`level=${ALL_LEVELS}`);
    // ...and nothing to filter.
    expect(html).not.toContain("materials-filter-type");
  });
});

const ROW = {
  id: "mat-1",
  label: "Past simple worksheet",
  unit: "Unit 3",
  body: null as string | null,
  storagePath: null as string | null,
  linkUrl: null as string | null,
  levelId: "lvl-a2",
  visibility: "at_or_below",
  contentSource: null as string | null,
  createdAt: new Date("2026-08-12T10:00:00Z"),
  focusTags: [],
  viewUrl: null as string | null,
  hasAnswerKey: false,
  revisions: [],
};

async function renderCard(over: Partial<typeof ROW> = {}) {
  return renderToStaticMarkup(
    await MaterialCard({
      material: { ...ROW, ...over },
      levelLabel: "A2",
      visibilityLabel: visibilityLabel("at_or_below"),
      view: "active",
      levels: LEVELS.map((l) => ({ id: l.id, label: l.label })),
      focusGroups: [],
      templates: [],
      aiEnabled: true,
      isPro: true,
      podcastEnabled: false,
      dateLabel: "12 Aug 2026",
    }),
  );
}

describe("MaterialCard", () => {
  it("names the kind in text, so it is not carried by the icon alone", async () => {
    expect(await renderCard({ body: "# Hi" })).toContain("Written");
    expect(await renderCard({ storagePath: "t/1-a.pdf" })).toContain("File");
    expect(await renderCard({ linkUrl: "https://x.test" })).toContain("Link");
  });

  it("shows a file's extension, which a custom label otherwise hides", async () => {
    const html = await renderCard({ storagePath: "t/1712-past-simple.pdf" });
    expect(html).toContain(">pdf<");
  });

  it("does not invent an extension for a written or linked material", async () => {
    expect(await renderCard({ body: "# Hi" })).not.toContain(">pdf<");
  });

  it("says when it was added, which is what makes the Newest sort legible", async () => {
    expect(await renderCard()).toContain("Added 12 Aug 2026");
  });

  it("marks an AI first draft, and only an AI first draft", async () => {
    expect(await renderCard({ body: "# Hi", contentSource: "ai" })).toContain(
      "First drafted with AI",
    );
    expect(await renderCard({ body: "# Hi", contentSource: "manual" })).not.toContain(
      "First drafted with AI",
    );
  });

  it("offers the answer-key download only when there is an answer key to withhold", async () => {
    expect(await renderCard({ body: "# Hi", hasAnswerKey: true })).toContain("answers=1");
    expect(await renderCard({ body: "# Hi", hasAnswerKey: false })).not.toContain("answers=1");
  });

  it("warns a screen reader that the title opens a new tab", async () => {
    const html = await renderCard({ viewUrl: "https://signed.test/x", linkUrl: "https://x.test" });
    expect(html).toContain("opens in a new tab");
    expect(html).toContain('target="_blank"');
  });

  it("shows Archive on the active shelf and Restore on the archived one", async () => {
    const active = await renderCard({ body: "# Hi" });
    expect(active).toContain("Archive");
    expect(active).not.toContain("Restore");

    const archived = renderToStaticMarkup(
      await MaterialCard({
        material: { ...ROW, body: "# Hi" },
        levelLabel: "A2",
        visibilityLabel: visibilityLabel("at_or_below"),
        view: "archived",
        levels: LEVELS.map((l) => ({ id: l.id, label: l.label })),
        focusGroups: [],
        templates: [],
        aiEnabled: true,
        isPro: true,
        podcastEnabled: false,
        dateLabel: "12 Aug 2026",
      }),
    );
    expect(archived).toContain("Restore");
    // An archived row is not editable or downloadable — restore it first.
    expect(archived).not.toContain("Download");
  });
});
