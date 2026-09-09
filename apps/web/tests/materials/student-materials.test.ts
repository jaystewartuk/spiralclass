import { describe, expect, it } from "vitest";
import {
  filterStudentMaterials,
  firstMarkdownHeading,
  groupStudentMaterials,
  materialDisplayTitle,
  type StudentMaterialItem,
} from "@/lib/materials/student-materials";

function item(overrides: Partial<StudentMaterialItem>): StudentMaterialItem {
  return {
    id: "m1",
    materialId: "mat1",
    bookingId: "b1",
    classStart: new Date("2026-07-10T15:00:00Z"),
    label: null,
    storagePath: null,
    linkUrl: "https://example.com",
    bodyHead: null,
    attachmentKind: "link",
    origin: "class",
    viewUrl: "https://example.com",
    href: "/dashboard/classes/b1",
    sendTiming: "t_24h",
    sent: true,
    usedInClass: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

const FALLBACKS = { content: "Class content", file: "File", link: "Link" };

describe("filterStudentMaterials", () => {
  it("passes everything through for 'all'", () => {
    const items = [item({ sent: true }), item({ id: "m2", sent: false })];
    expect(filterStudentMaterials(items, "all")).toHaveLength(2);
  });

  it("keeps only already-sent materials for 'sent'", () => {
    const items = [item({ id: "m1", sent: true }), item({ id: "m2", sent: false })];
    const result = filterStudentMaterials(items, "sent");
    expect(result.map((m) => m.id)).toEqual(["m1"]);
  });

  // The whole point of the history: "prepared" and "used" are different facts,
  // and a class routinely prepares more than it gets through.
  it("keeps only materials actually opened in class for 'used'", () => {
    const items = [
      item({ id: "m1", usedInClass: true, sent: false }),
      item({ id: "m2", usedInClass: false, sent: true }),
    ];
    const result = filterStudentMaterials(items, "used");
    expect(result.map((m) => m.id)).toEqual(["m1"]);
  });

  it("does not confuse 'used' with 'sent'", () => {
    // Sent to the student ahead of time but never opened on the call.
    const items = [item({ id: "m1", sent: true, usedInClass: false })];
    expect(filterStudentMaterials(items, "sent")).toHaveLength(1);
    expect(filterStudentMaterials(items, "used")).toHaveLength(0);
  });
});

describe("materialDisplayTitle", () => {
  it("prefers the teacher's own label", () => {
    expect(
      materialDisplayTitle({ label: "Ser vs estar", bodyHead: "# Something else" }, FALLBACKS),
    ).toBe("Ser vs estar");
  });

  // A class's own lesson content never has a label by design, so without this
  // every content row in the history would render the same generic word —
  // precisely the rows the teacher is scanning for.
  it("falls back to the body's first heading for unlabelled class content", () => {
    expect(
      materialDisplayTitle(
        { label: null, bodyHead: "Intro line\n\n## Past tense drills\n\nBody" },
        FALLBACKS,
      ),
    ).toBe("Past tense drills");
  });

  it("falls back to the generic content word when a body has no heading", () => {
    expect(materialDisplayTitle({ label: null, bodyHead: "Just prose." }, FALLBACKS)).toBe(
      "Class content",
    );
  });

  it("uses a link's hostname when there is no label and no body", () => {
    expect(
      materialDisplayTitle(
        { label: null, bodyHead: null, linkUrl: "https://www.bbc.co.uk/x" },
        FALLBACKS,
      ),
    ).toBe("bbc.co.uk");
  });

  it("falls back to the file word for an unlabelled file", () => {
    expect(materialDisplayTitle({ label: null, bodyHead: null, linkUrl: null }, FALLBACKS)).toBe(
      "File",
    );
  });

  it("falls back to the link word for an unparseable link", () => {
    expect(
      materialDisplayTitle({ label: null, bodyHead: null, linkUrl: "not a url" }, FALLBACKS),
    ).toBe("Link");
  });
});

describe("firstMarkdownHeading", () => {
  it("strips hashes on both sides", () => {
    expect(firstMarkdownHeading("### Conditionals ###")).toBe("Conditionals");
  });

  it("ignores a hash without a following space", () => {
    expect(firstMarkdownHeading("#nothashtag\n# Real heading")).toBe("Real heading");
  });

  it("returns null for a body with no heading", () => {
    expect(firstMarkdownHeading("plain text only")).toBeNull();
  });

  it("returns null for an empty or absent body", () => {
    expect(firstMarkdownHeading("")).toBeNull();
    expect(firstMarkdownHeading(null)).toBeNull();
  });

  it("caps a pathologically long heading", () => {
    expect(firstMarkdownHeading(`# ${"a".repeat(500)}`)).toHaveLength(120);
  });
});

describe("groupStudentMaterials", () => {
  const tz = "America/Mexico_City";

  it("groups by bookingId for 'class'", () => {
    const items = [
      item({ id: "m1", bookingId: "b1" }),
      item({ id: "m2", bookingId: "b2" }),
      item({ id: "m3", bookingId: "b1" }),
    ];
    const groups = groupStudentMaterials(items, "class", tz);
    expect(groups.map((g) => g.key)).toEqual(["b1", "b2"]);
    expect(groups[0].items.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("groups by local calendar day for 'date', independent of bookingId", () => {
    const items = [
      item({ id: "m1", bookingId: "b1", classStart: new Date("2026-07-10T15:00:00Z") }),
      item({ id: "m2", bookingId: "b2", classStart: new Date("2026-07-10T20:00:00Z") }),
      item({ id: "m3", bookingId: "b3", classStart: new Date("2026-07-11T15:00:00Z") }),
    ];
    const groups = groupStudentMaterials(items, "date", tz);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(groups[1].items.map((m) => m.id)).toEqual(["m3"]);
  });

  it("groups by attachment kind for 'type', content included", () => {
    const items = [
      item({ id: "m1", attachmentKind: "link" }),
      item({ id: "m2", attachmentKind: "file", storagePath: "x" }),
      item({ id: "m3", attachmentKind: "link" }),
      item({ id: "m4", attachmentKind: "content", linkUrl: null, bodyHead: "# Lesson" }),
    ];
    const groups = groupStudentMaterials(items, "type", tz);
    expect(groups.map((g) => g.key)).toEqual(["link", "file", "content"]);
    expect(groups[0].items.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("returns no groups for an empty input", () => {
    expect(groupStudentMaterials([], "class", tz)).toEqual([]);
  });
});
