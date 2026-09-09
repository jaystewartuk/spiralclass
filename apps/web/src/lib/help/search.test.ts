import { describe, expect, it } from "vitest";
import type { ContentDoc } from "@spiralclass/shared";
import { anchorLinkResolver, prepareHelpGuides } from "./guides";
import { buildHelpSearchEntries, searchHelpEntries } from "./search";

const guidesFor = (locale: string) => prepareHelpGuides(DOCS, locale, anchorLinkResolver(DOCS));

const DOCS: ContentDoc[] = [
  {
    slug: "packages-and-payments",
    audience: "teacher",
    title: { en: "Create packages and manage payments", "es-MX": "Crea paquetes" },
    summary: { en: "Create lesson offers and manage payments." },
    body: {
      en: [
        "## Purpose",
        "",
        "Create lesson offers, record a package, and manage refunds.",
        "",
        "## Steps",
        "",
        "### Create or edit an offer",
        "",
        "1. Open Settings.",
        "",
        "## Questions",
        "",
        "**When does a package expire?** On the expiry date set for that package.",
        "",
        "**What happens after a refund?** The remaining credit is removed.",
      ].join("\n"),
      "es-MX": "## Propósito\n\nCrea ofertas de clases.",
    },
  },
  {
    slug: "getting-started",
    audience: "teacher",
    title: { en: "Set up your teaching account" },
    summary: { en: "Set up your profile and availability." },
    body: { en: "## Purpose\n\nSet up your profile.\n\n## Tips\n\n- Use your own timezone." },
  },
];

describe("buildHelpSearchEntries", () => {
  const entries = buildHelpSearchEntries(guidesFor("en"));

  it("indexes each guide, each section and each question", () => {
    const kinds = entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds).toEqual({ guide: 2, section: 5, question: 2 });
  });

  it("points a question at its section's anchor, which the page renders", () => {
    const q = entries.find((e) => e.label === "When does a package expire?");
    expect(q?.id).toBe("guide-packages-and-payments-questions");
  });

  it("names the guide a section belongs to, so a result reads in context", () => {
    const section = entries.find((e) => e.kind === "section" && e.label === "Steps");
    expect(section?.context).toBe("Create packages and manage payments");
  });

  it("localizes titles and bodies", () => {
    const es = buildHelpSearchEntries(guidesFor("es-MX"));
    expect(es[0].label).toBe("Crea paquetes");
    expect(es.some((e) => e.label === "Propósito")).toBe(true);
  });

  it("keeps the guide's own entry first, in page order", () => {
    expect(entries[0]).toMatchObject({
      kind: "guide",
      label: "Create packages and manage payments",
    });
  });
});

describe("searchHelpEntries", () => {
  const entries = buildHelpSearchEntries(guidesFor("en"));

  it("returns nothing for an empty query", () => {
    expect(searchHelpEntries(entries, "   ")).toEqual([]);
  });

  it("finds an answer by words the reader did not have to phrase exactly", () => {
    const hits = searchHelpEntries(entries, "package expire");
    expect(hits[0].label).toBe("When does a package expire?");
  });

  it("ANDs the terms, so a second word narrows", () => {
    expect(searchHelpEntries(entries, "package zzz")).toEqual([]);
  });

  it("ignores case and accents on both sides", () => {
    const es = buildHelpSearchEntries(guidesFor("es-MX"));
    expect(searchHelpEntries(es, "proposito").map((e) => e.label)).toContain("Propósito");
  });

  it("ranks a label match above a body-only match", () => {
    const hits = searchHelpEntries(entries, "refund");
    expect(hits[0].label).toBe("What happens after a refund?");
  });

  it("finds a section by a sub-heading it contains", () => {
    const hits = searchHelpEntries(entries, "edit an offer");
    expect(hits[0].label).toBe("Steps");
  });

  it("caps the result list", () => {
    expect(searchHelpEntries(entries, "a", 3)).toHaveLength(3);
  });
});
