import { describe, expect, it } from "vitest";
import {
  countStudentMaterials,
  formatMediaDuration,
  isStudentMaterialFilter,
  matchesSearch,
  normalizeForSearch,
  studentMaterialSearchText,
} from "@/lib/library/student-library-filter";
import { studentMaterialTitle } from "@/lib/materials/student-materials";

const FALLBACKS = { content: "Class content", file: "File", link: "Link" };

describe("isStudentMaterialFilter", () => {
  it("accepts every shipped bucket", () => {
    for (const value of ["all", "assigned", "class", "browse"]) {
      expect(isStudentMaterialFilter(value)).toBe(true);
    }
  });

  it("rejects anything else, including non-strings", () => {
    for (const value of ["", "ALL", "browse ", "sent", null, undefined, 3, {}]) {
      expect(isStudentMaterialFilter(value)).toBe(false);
    }
  });
});

describe("normalizeForSearch", () => {
  // The reason this function exists: two of three shipped locales are accented,
  // and a student typing on a keyboard without dead keys must still find her
  // own materials.
  it("folds accents and case", () => {
    expect(normalizeForSearch("Práctica")).toBe("practica");
    expect(normalizeForSearch("Élève")).toBe("eleve");
    expect(normalizeForSearch("MAÑANA")).toBe("manana");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeForSearch("  hola  ")).toBe("hola");
  });
});

describe("studentMaterialSearchText", () => {
  it("gathers title, unit, level and tags into one normalized haystack", () => {
    const text = studentMaterialSearchText({
      title: "Pretérito vs Copretérito",
      unit: "Unidad 4",
      levelLabel: "B1",
      tags: [{ id: "t1", label: "Gramática", categoryId: "c1" }],
    });
    expect(text).toContain("preterito vs copreterito");
    expect(text).toContain("unidad 4");
    expect(text).toContain("b1");
    expect(text).toContain("gramatica");
  });

  it("skips absent fields rather than emitting empty separators", () => {
    expect(studentMaterialSearchText({ title: "Solo" })).toBe("solo");
  });

  // The body is markdown that can run to thousands of characters and would
  // otherwise cross the wire a second time purely to be searched.
  it("caps how much of the body it searches", () => {
    const body = `${"a".repeat(600)}needle`;
    const text = studentMaterialSearchText({ title: "T", body });
    expect(text).not.toContain("needle");
    expect(text.length).toBeLessThan(650);
  });
});

describe("matchesSearch", () => {
  const haystack = studentMaterialSearchText({
    title: "Present perfect drills",
    levelLabel: "B1",
    tags: [{ id: "t1", label: "Verbs", categoryId: "c1" }],
  });

  it("matches an empty or whitespace query so a cleared box shows everything", () => {
    expect(matchesSearch(haystack, "")).toBe(true);
    expect(matchesSearch(haystack, "   ")).toBe(true);
  });

  it("matches a substring regardless of case", () => {
    expect(matchesSearch(haystack, "PERFECT")).toBe(true);
  });

  // Order-independent term matching: "b1 verbs" is how a person narrows down,
  // and a single-substring match would find nothing.
  it("requires every term but not their order", () => {
    expect(matchesSearch(haystack, "b1 verbs")).toBe(true);
    expect(matchesSearch(haystack, "verbs b1")).toBe(true);
    expect(matchesSearch(haystack, "b1 nouns")).toBe(false);
  });

  it("matches an accented material from an unaccented query", () => {
    const accented = studentMaterialSearchText({ title: "Práctica de mañana" });
    expect(matchesSearch(accented, "practica manana")).toBe(true);
  });
});

describe("countStudentMaterials", () => {
  it("counts each bucket and totals them into `all`", () => {
    expect(countStudentMaterials(["assigned", "class", "class", "browse"])).toEqual({
      all: 4,
      assigned: 1,
      class: 2,
      browse: 1,
    });
  });

  it("returns zeroes for an empty shelf rather than an empty object", () => {
    expect(countStudentMaterials([])).toEqual({ all: 0, assigned: 0, class: 0, browse: 0 });
  });
});

describe("formatMediaDuration", () => {
  it("reads as a clock, zero-padding the seconds", () => {
    expect(formatMediaDuration(252)).toBe("4:12");
    expect(formatMediaDuration(65)).toBe("1:05");
    expect(formatMediaDuration(9)).toBe("0:09");
  });

  it("grows an hours field past the hour", () => {
    expect(formatMediaDuration(3723)).toBe("1:02:03");
  });

  it("rounds fractional seconds", () => {
    expect(formatMediaDuration(59.6)).toBe("1:00");
  });

  // A label is dropped entirely rather than printing "0:00" beside audio that
  // plainly is not zero seconds long.
  it("returns null for a missing or nonsensical duration", () => {
    expect(formatMediaDuration(null)).toBeNull();
    expect(formatMediaDuration(undefined)).toBeNull();
    expect(formatMediaDuration(0)).toBeNull();
    expect(formatMediaDuration(-5)).toBeNull();
    expect(formatMediaDuration(Number.NaN)).toBeNull();
  });
});

describe("studentMaterialTitle", () => {
  it("prefers the teacher's own label", () => {
    expect(
      studentMaterialTitle(
        { label: "Worksheet 3", body: "# Ignored", attachmentKind: "content" },
        FALLBACKS,
      ),
    ).toBe("Worksheet 3");
  });

  it("names an unlabelled lesson after its first heading", () => {
    expect(
      studentMaterialTitle(
        { label: null, body: "# Subjunctive mood\n\nsome text", attachmentKind: "content" },
        FALLBACKS,
      ),
    ).toBe("Subjunctive mood");
  });

  it("names an unlabelled link after its host", () => {
    expect(
      studentMaterialTitle(
        { label: null, linkUrl: "https://www.youtube.com/watch?v=x", attachmentKind: "link" },
        FALLBACKS,
      ),
    ).toBe("youtube.com");
  });

  // The whole reason this wrapper exists: a unified material carrying a file
  // AND a link is a file, and must not be titled after the URL hanging off it.
  it("never titles a file after a link it also carries", () => {
    expect(
      studentMaterialTitle(
        { label: null, linkUrl: "https://example.com/x", attachmentKind: "file" },
        FALLBACKS,
      ),
    ).toBe("File");
  });

  // A material that is nothing but an answer key strips to "" for the student
  // and is still a lesson, not a file.
  it("keeps a body-stripped-to-empty material on the content fallback", () => {
    expect(
      studentMaterialTitle({ label: null, body: "", attachmentKind: "content" }, FALLBACKS),
    ).toBe("Class content");
  });
});
