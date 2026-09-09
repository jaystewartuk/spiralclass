import { describe, expect, it } from "vitest";
import type { ContentDoc } from "@spiralclass/shared";
import { anchorLinkResolver, prepareHelpGuides } from "./guides";

const DOCS: ContentDoc[] = [
  {
    slug: "settings-and-subscription",
    audience: "teacher",
    title: { en: "Manage settings and your plan", "es-MX": "Administra tu configuración" },
    summary: { en: "Update your profile and plan.", "es-MX": "Actualiza tu perfil." },
    body: {
      en: [
        "## Purpose",
        "",
        "Update your profile.",
        "",
        "## Tips",
        "",
        "See [Create packages](packages-and-payments.md) and [Manage students](students.md).",
      ].join("\n"),
      "es-MX": "## Propósito\n\nActualiza tu perfil.",
    },
  },
  {
    slug: "packages-and-payments",
    audience: "teacher",
    title: { en: "Create packages and manage payments" },
    summary: { en: "Create lesson offers." },
    body: { en: "## Purpose\n\nCreate offers." },
  },
];

describe("prepareHelpGuides", () => {
  const guides = prepareHelpGuides(DOCS, "en", anchorLinkResolver(DOCS));

  it("keeps the docs in order and anchors each guide", () => {
    expect(guides.map((g) => g.id)).toEqual([
      "guide-settings-and-subscription",
      "guide-packages-and-payments",
    ]);
  });

  it("anchors every section under its own guide", () => {
    expect(guides[0].sections.map((s) => s.id)).toEqual([
      "guide-settings-and-subscription-purpose",
      "guide-settings-and-subscription-tips",
    ]);
    // Both guides have a "Purpose"; the ids must not collide on one page.
    expect(guides[1].sections[0].id).toBe("guide-packages-and-payments-purpose");
  });

  it("points a cross-reference at the guide's anchor on the same page", () => {
    expect(guides[0].sections[1].body).toContain("[Create packages](#guide-packages-and-payments)");
  });

  it("unwraps a cross-reference the page cannot reach, leaving no dead link", () => {
    expect(guides[0].sections[1].body).toContain("and Manage students.");
    expect(guides[0].sections[1].body).not.toContain("students.md");
  });

  it("localizes title, summary and body together", () => {
    const es = prepareHelpGuides(DOCS, "es-MX", anchorLinkResolver(DOCS));
    expect(es[0].title).toBe("Administra tu configuración");
    expect(es[0].summary).toBe("Actualiza tu perfil.");
    // The es-MX body's only section IS the summary, so the echo rule removes
    // it — the point being that the rule matches translated docs too, having
    // nothing to do with the English word "Purpose".
    expect(es[0].sections).toEqual([]);
  });

  it("drops an opening section that only repeats the summary", () => {
    const [guide] = prepareHelpGuides(
      [
        {
          ...DOCS[1],
          summary: { en: "Create offers." },
          body: { en: "## Purpose\n\nCreate offers.\n\n## Tips\n\n- One." },
        },
      ],
      "en",
      () => null,
    );
    expect(guide.sections.map((s) => s.heading)).toEqual(["Tips"]);
  });

  it("keeps an opening section that says more than the summary", () => {
    const [guide] = prepareHelpGuides(
      [
        {
          ...DOCS[1],
          summary: { en: "Create offers." },
          body: { en: "## Purpose\n\nCreate offers.\n\nAnd manage refunds.\n\n## Tips\n\n- One." },
        },
      ],
      "en",
      () => null,
    );
    expect(guide.sections.map((s) => s.heading)).toEqual(["Purpose", "Tips"]);
  });

  it("takes an arbitrary resolver, so a single-article page can link to routes", () => {
    const routed = prepareHelpGuides(DOCS, "en", (slug) => `/help/teacher/${slug}`);
    expect(routed[0].sections[1].body).toContain("(/help/teacher/packages-and-payments)");
    expect(routed[0].sections[1].body).toContain("(/help/teacher/students)");
  });

  it("drops content with no heading, since it has nothing to be linked to", () => {
    const [guide] = prepareHelpGuides(
      [{ ...DOCS[1], body: { en: "Lead-in prose.\n\n## Purpose\n\nBody." } }],
      "en",
      () => null,
    );
    expect(guide.sections.map((s) => s.heading)).toEqual(["Purpose"]);
  });
});
