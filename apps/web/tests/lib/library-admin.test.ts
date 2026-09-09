import { describe, expect, it } from "vitest";
import type { LibraryListRow } from "@/lib/library/library-queries";
import { mapLibraryRowToAdmin } from "@/lib/materials/library-admin";

// The library row → wire shape mapper. Covered here for the part the in-call
// library tab depends on: `fileKind`, which decides whether a material the
// teacher picks mid-lesson opens IN the call or throws her out to a browser
// tab. The client cannot re-derive it — it holds a signed URL, and the
// filename this reads lives on the server.

const LEVELS = new Map([["lvl1", "A1"]]);

const row = (over: Partial<LibraryListRow>): LibraryListRow =>
  ({
    id: "m1",
    levelId: "lvl1",
    visibility: "at_or_below",
    unit: null,
    label: "Worksheet",
    storagePath: null,
    linkUrl: null,
    body: null,
    contentSource: null,
    archived: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    focusTags: [],
    ...over,
  }) as LibraryListRow;

const map = (over: Partial<LibraryListRow>) =>
  mapLibraryRowToAdmin(row(over), LEVELS, async () => "https://signed/x");

describe("mapLibraryRowToAdmin fileKind", () => {
  it("marks a PDF and an image as renderable in place", async () => {
    expect((await map({ storagePath: "t1/1712-worksheet.pdf" })).fileKind).toBe("pdf");
    expect((await map({ storagePath: "t1/1712-board.jpeg" })).fileKind).toBe("image");
  });

  it("marks any other file 'other', so it keeps opening outside the call", async () => {
    expect((await map({ storagePath: "t1/1712-slides.pptx" })).fileKind).toBe("other");
    expect((await map({ storagePath: "t1/1712-diagram.svg" })).fileKind).toBe("other");
  });

  it("is null for a link and for native content — neither has a stored file", async () => {
    expect((await map({ linkUrl: "https://example.com/a.pdf" })).fileKind).toBeNull();
    expect((await map({ body: "# Hello" })).fileKind).toBeNull();
  });

  it("is null for a body-bearing row that also carries a file, matching its kind", async () => {
    // Kind precedence here is body > file (the mapper's own rule), and
    // fileKind follows the kind rather than the columns: the viewer renders
    // that row's Markdown, not its attachment.
    const out = await map({ body: "# Hello", storagePath: "t1/1712-worksheet.pdf" });
    expect(out.attachmentKind).toBe("content");
    expect(out.fileKind).toBeNull();
  });
});
