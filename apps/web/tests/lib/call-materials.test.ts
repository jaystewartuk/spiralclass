import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getCallMaterials } from "@/lib/materials/call-materials";

// getCallMaterials resolves the materials shown in the in-call viewer for one
// class. Injectable deps (db, mintUrl, now) let the mapping — kind resolution,
// the student send-time gate, content-body vs file/link URL — be tested without
// a database, the same pattern as getStudentLibraryView.

const NOW = new Date("2026-05-01T12:00:00.000Z");
// A class 2 days out, so t_1h / t_24h send moments are still in the future
// (not yet elapsed) while t_5d / confirmation / null are already released.
const START = new Date("2026-05-03T12:00:00.000Z");

type Row = {
  id: string;
  label: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  body: string | null;
};

const file = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  label: id,
  storagePath: `t1/${id}.pdf`,
  linkUrl: null,
  body: null,
  ...over,
});
const link = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  label: id,
  storagePath: null,
  linkUrl: `https://x/${id}`,
  body: null,
  ...over,
});
const content = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  label: id,
  storagePath: null,
  linkUrl: null,
  body: `# ${id}`,
  ...over,
});

function fakeDb(
  booking: {
    materials?: (Row & { sendTiming: string | null })[];
    libraryMaterials?: { sendTiming: string; material: Row }[];
  } | null,
): PrismaClient {
  return {
    booking: {
      findFirst: vi.fn(async () =>
        booking === null
          ? null
          : {
              scheduledStart: START,
              materials: booking.materials ?? [],
              libraryMaterials: booking.libraryMaterials ?? [],
            },
      ),
    },
  } as unknown as PrismaClient;
}

// Signed-URL minter stand-in: file → signed://path, link → the raw url.
const mintUrl = async (m: { storagePath: string | null; linkUrl: string | null }) =>
  m.storagePath ? `signed://${m.storagePath}` : m.linkUrl;

const deps = (db: PrismaClient) => ({ db, mintUrl, now: NOW });

describe("getCallMaterials", () => {
  it("maps each kind: content carries body (no url), file/link carry a url (no body)", async () => {
    const db = fakeDb({
      materials: [
        { ...content("c1"), sendTiming: null },
        { ...file("f1"), sendTiming: null },
        { ...link("l1"), sendTiming: null },
      ],
    });
    const out = await getCallMaterials("b1", { audience: "teacher" }, deps(db));
    expect(out).toEqual([
      { id: "c1", label: "c1", kind: "content", body: "# c1", viewUrl: null, fileKind: null },
      {
        id: "f1",
        label: "f1",
        kind: "file",
        body: null,
        viewUrl: "signed://t1/f1.pdf",
        fileKind: "pdf",
      },
      { id: "l1", label: "l1", kind: "link", body: null, viewUrl: "https://x/l1", fileKind: null },
    ]);
  });

  // Which renderer the in-call viewer reaches for. Read off the STORED path,
  // which is why a link whose URL happens to end in .pdf is still null: it is
  // a cross-origin document this app never fetches, not a file it holds.
  it("resolves fileKind from the stored filename, and only for file rows", async () => {
    const db = fakeDb({
      materials: [
        { ...file("f1", { storagePath: "t1/worksheet.pdf" }), sendTiming: null },
        { ...file("f2", { storagePath: "t1/board.PNG" }), sendTiming: null },
        { ...file("f3", { storagePath: "t1/slides.pptx" }), sendTiming: null },
        { ...file("f4", { storagePath: "t1/diagram.svg" }), sendTiming: null },
        { ...link("l1", { linkUrl: "https://x/remote.pdf" }), sendTiming: null },
        { ...content("c1"), sendTiming: null },
      ],
    });
    const out = await getCallMaterials("b1", { audience: "teacher" }, deps(db));
    expect(out.map((m) => m.fileKind)).toEqual(["pdf", "image", "other", "other", null, null]);
  });

  it("includes attached library items alongside booking-scoped rows", async () => {
    const db = fakeDb({
      materials: [{ ...content("own"), sendTiming: null }],
      libraryMaterials: [{ sendTiming: "confirmation", material: file("lib") }],
    });
    const out = await getCallMaterials("b1", { audience: "teacher" }, deps(db));
    expect(out.map((m) => m.id)).toEqual(["own", "lib"]);
  });

  it("teacher sees not-yet-released materials", async () => {
    const db = fakeDb({
      // t_1h hasn't elapsed for a class 2 days out — a student wouldn't see it.
      materials: [{ ...file("early"), sendTiming: "t_1h" }],
    });
    const out = await getCallMaterials("b1", { audience: "teacher" }, deps(db));
    expect(out.map((m) => m.id)).toEqual(["early"]);
  });

  it("student hides materials whose send time hasn't elapsed", async () => {
    const db = fakeDb({
      materials: [
        { ...file("released"), sendTiming: null }, // always visible
        { ...file("early"), sendTiming: "t_1h" }, // not elapsed (class 2 days out)
      ],
    });
    const out = await getCallMaterials("b1", { audience: "student" }, deps(db));
    expect(out.map((m) => m.id)).toEqual(["released"]);
  });

  it("dedupes a material id that appears via more than one attach path", async () => {
    const db = fakeDb({
      materials: [{ ...file("dup"), sendTiming: null }],
      libraryMaterials: [{ sendTiming: "confirmation", material: file("dup") }],
    });
    const out = await getCallMaterials("b1", { audience: "teacher" }, deps(db));
    expect(out.map((m) => m.id)).toEqual(["dup"]);
  });

  it("returns an empty list when the booking is not found", async () => {
    const out = await getCallMaterials("missing", { audience: "teacher" }, deps(fakeDb(null)));
    expect(out).toEqual([]);
  });
});

// The answer-key half of `audience`. The send-timing gate above answers "which
// materials"; this answers "how much of each" — and it is the half that has to
// hold server-side, because whatever this function returns for a student is
// serialized straight into her RSC payload (web) or her call-token JSON
// (mobile). The renderers' "Show answer" toggle is presentation, not a
// boundary.
describe("getCallMaterials answer-key filtering", () => {
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

  const answered = (id: string): Row & { sendTiming: null } => ({
    ...content(id, { body: ANSWERED }),
    sendTiming: null,
  });

  it("the teacher's copy keeps the answer key verbatim", async () => {
    const out = await getCallMaterials(
      "b1",
      { audience: "teacher" },
      deps(
        fakeDb({
          materials: [answered("c1")],
        }),
      ),
    );
    expect(out[0].body).toBe(ANSWERED);
  });

  it("the student's copy has every answer callout cut out, at any depth", async () => {
    const out = await getCallMaterials(
      "b1",
      { audience: "student" },
      deps(
        fakeDb({
          materials: [answered("c1")],
        }),
      ),
    );
    expect(out[0].body).toContain("Complete the gap");
    expect(out[0].body).toContain("Third person singular.");
    expect(out[0].body).not.toContain("[!answer]");
    expect(out[0].body).not.toContain("goes");
    expect(out[0].body).not.toContain("Because the subject is");
  });

  it("strips attached library items too, not just booking-scoped rows", async () => {
    const out = await getCallMaterials(
      "b1",
      { audience: "student" },
      deps(
        fakeDb({
          libraryMaterials: [
            { sendTiming: "confirmation", material: content("lib", { body: ANSWERED }) },
          ],
        }),
      ),
    );
    expect(out.map((m) => m.id)).toEqual(["lib"]);
    expect(out[0].body).not.toContain("[!answer]");
  });

  it("no student-visible body anywhere in the list carries an answer callout", async () => {
    // The blanket assertion, so a new field or a new attach path can't quietly
    // reintroduce the leak this test file exists to pin.
    const out = await getCallMaterials(
      "b1",
      { audience: "student" },
      deps(
        fakeDb({
          materials: [answered("c1"), { ...file("f1"), sendTiming: null }, answered("c2")],
          libraryMaterials: [
            { sendTiming: "confirmation", material: content("lib", { body: ANSWERED }) },
          ],
        }),
      ),
    );
    expect(out).toHaveLength(4);
    expect(JSON.stringify(out)).not.toContain("[!answer]");
    expect(JSON.stringify(out)).not.toContain("Because the subject is");
  });

  it("leaves a body with no answer key byte-identical", async () => {
    const body = "# Lesson\n\n> [!tip]\n> Read it aloud.";
    const out = await getCallMaterials(
      "b1",
      { audience: "student" },
      deps(
        fakeDb({
          materials: [{ ...content("c1", { body }), sendTiming: null }],
        }),
      ),
    );
    expect(out[0].body).toBe(body);
  });

  it("keeps a material whose whole body was an answer key as an empty content material", async () => {
    const out = await getCallMaterials(
      "b1",
      { audience: "student" },
      deps(
        fakeDb({
          materials: [{ ...content("c1", { body: "> [!answer]\n> 42" }), sendTiming: null }],
        }),
      ),
    );
    expect(out[0]).toEqual({
      id: "c1",
      label: "c1",
      kind: "content",
      body: "",
      viewUrl: null,
      fileKind: null,
    });
  });
});
