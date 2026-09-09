import { describe, expect, it } from "vitest";
import { decodeCallMaterialOpen, encodeCallMaterialOpen } from "@spiralclass/shared";
import { buildLibraryQueryParams, toCallMaterial } from "@/components/video/call-library-browser";

// The teacher-only "My library" browser inside the in-call Materials sheet.
// These two pure pieces carry the parts most likely to silently drift:
// (1) mapping a picked library row into the exact CallMaterial shape the
// viewer/opener already handles for class materials, and (2) building the
// query string against GET /api/mobile/teacher/library/materials the same way
// parseLibraryListParams (server-side) expects to parse it.

describe("toCallMaterial", () => {
  it("maps a content item, carrying its body and no viewUrl", () => {
    expect(
      toCallMaterial({
        id: "m1",
        levelId: "l1",
        levelLabel: "A1",
        visibility: "at_or_below",
        unit: null,
        label: "My lesson",
        attachmentKind: "content",
        viewUrl: null,
        fileKind: null,
        body: "# Hello",
        source: "manual",
        archived: false,
        focusTagIds: [],
      }),
    ).toEqual({
      id: "m1",
      label: "My lesson",
      kind: "content",
      body: "# Hello",
      viewUrl: null,
      fileKind: null,
    });
  });

  it("maps a file item, carrying its signed viewUrl and no body", () => {
    expect(
      toCallMaterial({
        id: "m2",
        levelId: "l1",
        levelLabel: "A1",
        visibility: "all",
        unit: null,
        label: "Worksheet",
        attachmentKind: "file",
        viewUrl: "https://signed/worksheet.pdf",
        // Server-resolved from the stored filename (lib/materials/library-admin
        // .ts) and carried straight through: it is what lets a PDF picked from
        // the library open IN the call rather than in a browser tab.
        fileKind: "pdf",
        archived: false,
        focusTagIds: [],
      }),
    ).toEqual({
      id: "m2",
      label: "Worksheet",
      kind: "file",
      body: null,
      viewUrl: "https://signed/worksheet.pdf",
      fileKind: "pdf",
    });
  });

  it("falls back a missing body to null (a content row should always carry one, but never leak undefined)", () => {
    expect(
      toCallMaterial({
        id: "m3",
        levelId: "l1",
        levelLabel: "A1",
        visibility: "exact",
        unit: null,
        label: null,
        attachmentKind: "link",
        viewUrl: "https://example.com",
        fileKind: null,
        archived: false,
        focusTagIds: [],
      }).body,
    ).toBeNull();
  });
});

describe("buildLibraryQueryParams", () => {
  const noFilters = { category: null, level: null, type: null, visibility: null };

  it("carries only limit when no filter/search/sort is active (the default 'recent' sort is omitted)", () => {
    const p = buildLibraryQueryParams(noFilters, "", "recent", 30, null);
    expect(p.toString()).toBe("limit=30");
  });

  it("includes every active filter axis plus a trimmed search term", () => {
    const p = buildLibraryQueryParams(
      { category: "cat1", level: "lvl1", type: "file", visibility: "all" },
      "  worksheet  ",
      "recent",
      30,
      null,
    );
    expect(p.get("category")).toBe("cat1");
    expect(p.get("level")).toBe("lvl1");
    expect(p.get("type")).toBe("file");
    expect(p.get("visibility")).toBe("all");
    expect(p.get("q")).toBe("worksheet");
  });

  it("omits q entirely for a whitespace-only search", () => {
    const p = buildLibraryQueryParams(noFilters, "   ", "recent", 30, null);
    expect(p.has("q")).toBe(false);
  });

  it("only sends sort when it's not the default", () => {
    expect(buildLibraryQueryParams(noFilters, "", "oldest", 30, null).get("sort")).toBe("oldest");
    expect(buildLibraryQueryParams(noFilters, "", "recent", 30, null).has("sort")).toBe(false);
  });

  it("carries the cursor through for a load-more page", () => {
    const p = buildLibraryQueryParams(noFilters, "", "recent", 30, "cursor-id-1");
    expect(p.get("cursor")).toBe("cursor-id-1");
  });
});

// THE SCENARIO THIS FILE'S MODULE MOST NEEDS PINNED: the teacher picks an item
// from her OWN library mid-call and opens it on the student's screen. That item
// never passed through getCallMaterials (it is not attached to this booking),
// so the server-side answer-key strip does not cover it — the ONLY thing
// between the teacher's authoring copy and the student's device is the wire
// protocol. `toCallMaterial` deliberately keeps the full body (the teacher may
// be opening it on her own screen too, via "for both"); the cut happens when
// the packet is built.
describe("opening a library item on the student's screen", () => {
  const ANSWERED = [
    "> [!exercise]",
    "> Complete the gap: She (go) to school.",
    "",
    "> [!answer]",
    "> goes",
    "",
    "> [!question] Why?",
    "> Third person singular.",
    ">",
    "> > [!answer]",
    "> > Because the subject is 'she'.",
  ].join("\n");

  const picked = () =>
    toCallMaterial({
      id: "m1",
      levelId: "l1",
      levelLabel: "A1",
      visibility: "at_or_below",
      unit: null,
      label: "Present simple",
      attachmentKind: "content",
      viewUrl: null,
      fileKind: null,
      body: ANSWERED,
      source: "manual",
      archived: false,
      focusTagIds: [],
    });

  it("keeps the answers in the teacher's own copy", () => {
    expect(picked().body).toBe(ANSWERED);
  });

  it("puts no answer text on the wire, and none in what the student decodes", () => {
    const packet = encodeCallMaterialOpen({ for: "student-1", material: picked() });
    const onTheWire = new TextDecoder().decode(packet);
    const asStudentSeesIt = decodeCallMaterialOpen(packet);

    for (const seen of [onTheWire, JSON.stringify(asStudentSeesIt)]) {
      expect(seen).toContain("Complete the gap");
      expect(seen).toContain("Third person singular.");
      expect(seen).not.toContain("[!answer]");
      expect(seen).not.toContain("goes");
      expect(seen).not.toContain("Because the subject is");
    }
  });
});
