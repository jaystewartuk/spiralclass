import { describe, expect, it } from "vitest";
import { getContentDoc, listContentDocs } from "@spiralclass/shared";
import { prepareHelpGuides } from "@/lib/help/guides";
import { helpSearchEntries } from "@/lib/search/help-entries";
import { indexSearchEntries, searchEntries } from "@/lib/search/match";
import { searchWithinLinks } from "@/lib/search/within";

describe("helpSearchEntries", () => {
  it.each(["teacher", "student"] as const)(
    "links every %s result to an article and an anchor that article renders",
    (audience) => {
      const entries = helpSearchEntries(audience, "en");
      expect(entries.length).toBeGreaterThan(listContentDocs(audience).length);
      for (const entry of entries) {
        expect(entry.kind).toBe("help");
        const [path, anchor] = entry.href.split("#");
        const slug = path?.replace(`/help/${audience}/`, "") ?? "";
        const doc = getContentDoc(audience, slug);
        expect(doc, entry.href).toBeDefined();
        if (!anchor || !doc) continue;
        // The article page renders prepareHelpGuides([doc]) and gives each
        // section this id — the same parse, so the same ids.
        const [guide] = prepareHelpGuides([doc], "en", () => null);
        expect(
          guide?.sections.map((s) => s.id),
          entry.href,
        ).toContain(anchor);
      }
    },
  );

  it("gives every entry a unique id", () => {
    const entries = helpSearchEntries("teacher", "en");
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it("is written in the reader's language", () => {
    const en = helpSearchEntries("teacher", "en").map((e) => e.label);
    const es = helpSearchEntries("teacher", "es").map((e) => e.label);
    expect(es).not.toEqual(en);
  });

  it("finds the answer to a question about packages", () => {
    const index = indexSearchEntries(helpSearchEntries("teacher", "en"));
    const results = searchEntries(index, "package");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.href.startsWith("/help/teacher/"))).toBe(true);
  });
});

describe("searchWithinLinks", () => {
  it("offers nothing for an empty query", () => {
    expect(searchWithinLinks("teacher", "  ")).toEqual([]);
  });

  it("hands a teacher's query to each page that searches everything of its kind", () => {
    const links = Object.fromEntries(
      searchWithinLinks("teacher", " Marco López ").map((l) => [l.id, l.href]),
    );
    expect(links.students).toBe("/dashboard/students?q=Marco+L%C3%B3pez");
    expect(links.classes).toBe("/dashboard/classes?show=past&q=Marco+L%C3%B3pez");
    expect(links.leads).toBe("/dashboard/leads?q=Marco+L%C3%B3pez");
    expect(links.materials).toBe("/dashboard/materials?level=all&q=Marco+L%C3%B3pez");
  });

  it("hands a student's query to her materials page, which owns what she may see", () => {
    expect(searchWithinLinks("student", "verbs")).toEqual([
      {
        id: "materials",
        label: "web.search.within.materials",
        href: "/my-classes/materials?q=verbs",
      },
    ]);
  });
});
