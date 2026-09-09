import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// SSR checks on the lesson-template manager. The unit environment is `node`,
// so these pin the markup contract the redesign is responsible for — the
// posted payload, the label/field wiring, and the disclosure semantics — while
// the decisions behind them (outline, unsaved-change summary, per-row
// validation) are unit-tested directly in tests/materials/template-editor.test.ts.

vi.mock("@/app/actions/class-content", () => ({
  saveClassContentTemplatesAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
// The Markdown renderer is only reached in preview mode (closed on first
// render); stubbed so this test does not pull the whole document pipeline in.
vi.mock("@/components/class-content/class-content-markdown", () => ({
  ClassContentMarkdown: ({ body }: { body: string }) =>
    React.createElement("div", { "data-preview": true }, body),
}));

const { ClassContentTemplatesForm } =
  await import("@/app/(app)/settings/class-content-templates/class-content-templates-form");

const TEMPLATES = [
  { id: "t1", label: "Gramática en Contexto", body: "## Bienvenida\n## Objetivo" },
  { id: "t2", label: "Conversation hour", body: "## Warm-up\n## Debate" },
];

const render = (initial: typeof TEMPLATES) =>
  renderToStaticMarkup(React.createElement(ClassContentTemplatesForm, { initial }));

describe("ClassContentTemplatesForm — posted payload", () => {
  const html = render(TEMPLATES);

  it("posts the replace-set field names the server action reads", () => {
    for (const name of ["tpl_id", "tpl_label", "tpl_body", "tpl_keep"]) {
      expect(html).toContain(`name="${name}"`);
    }
  });

  it("posts one hidden group per template, in list order", () => {
    const ids = [...html.matchAll(/name="tpl_id" value="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("marks every rendered row as kept", () => {
    const keeps = [...html.matchAll(/name="tpl_keep" value="([^"]*)"/g)].map((m) => m[1]);
    expect(keeps).toEqual(["1", "1"]);
  });

  it("carries the body in the posted value, not only in the textarea", () => {
    // The textarea unmounts in preview mode; the hidden input is what the
    // action actually reads, so a body must never depend on the editor being
    // the visible half of the row.
    expect(html).toContain('name="tpl_body" value="## Bienvenida');
  });
});

describe("ClassContentTemplatesForm — field wiring", () => {
  const html = render(TEMPLATES);

  it("labels the name and body fields with matching ids", () => {
    expect(html).toContain('for="tpl-name-t1"');
    expect(html).toContain('id="tpl-name-t1"');
    expect(html).toContain('for="tpl-body-t1"');
    expect(html).toContain('id="tpl-body-t1"');
  });

  it("describes the body field with its help text", () => {
    expect(html).toContain('aria-describedby="tpl-help-t1"');
    expect(html).toContain('id="tpl-help-t1"');
  });

  it("caps the name field at the column's own limit", () => {
    // React 19's static markup keeps the JSX casing for these attributes;
    // HTML attribute names are case-insensitive, so this is the real output.
    expect(html).toContain('maxLength="80"');
  });

  it("keeps the submit path free of native required attributes", () => {
    // Validation is explicit and per row now: `required` on a field that
    // unmounts in preview mode blocked nothing and explained nothing.
    expect(html).toContain('noValidate=""');
    expect(html).not.toContain('required=""');
  });
});

describe("ClassContentTemplatesForm — disclosure", () => {
  const html = render(TEMPLATES);

  it("renders each row as a collapsed disclosure over its own panel", () => {
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="tpl-panel-t1"');
    expect(html).toContain('id="tpl-panel-t1"');
  });

  it("hides the panel of a collapsed row", () => {
    expect(html).toMatch(/id="tpl-panel-t1"[^>]*hidden/);
  });

  it("summarises a collapsed row with the headings the template imposes", () => {
    expect(html).toContain("Bienvenida · Objetivo");
    expect(html).toContain("Warm-up · Debate");
  });

  it("gives every row a labelled drag handle", () => {
    const handles = html.match(
      /aria-label="web\.settings\.classContentTemplates\.dragHandleAria"/g,
    );
    expect(handles).toHaveLength(2);
  });
});

describe("ClassContentTemplatesForm — nothing saved yet", () => {
  const html = render([]);

  it("explains the feature instead of showing a bare pair of buttons", () => {
    expect(html).toContain("web.settings.classContentTemplates.emptyTitle");
    expect(html).toContain("web.settings.classContentTemplates.emptyBody");
    expect(html).toContain("web.settings.classContentTemplates.startFromExample");
  });

  it("posts no rows", () => {
    expect(html).not.toContain('name="tpl_id"');
  });

  it("shows no unsaved-changes bar on a clean list", () => {
    expect(html).not.toContain("web.settings.classContentTemplates.unsaved");
    expect(html).not.toContain("settings.classContentTemplates.save");
  });
});
