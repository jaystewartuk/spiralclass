import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getStudentClassContent } from "@/lib/materials/class-content";

// The student's copy of a class's native written content (D-17/D-69). This
// resolver exists so the three student surfaces that read that row — the web
// class page, the web print view and the mobile class-detail endpoint — cannot
// disagree about how much of it a student is shown. The teacher's own read
// (findContentMaterial, scoped by teacherId) deliberately keeps the answers.

const ANSWERED = [
  "# Present simple",
  "",
  "> [!exercise]",
  "> Complete the gap: She (go) to school.",
  "",
  "> [!answer]",
  "> goes",
].join("\n");

const fakeDb = (row: unknown): PrismaClient =>
  ({ libraryMaterial: { findFirst: vi.fn(async () => row) } }) as unknown as PrismaClient;

describe("getStudentClassContent", () => {
  it("cuts the answer key out of the body", async () => {
    const out = await getStudentClassContent("b1", {
      db: fakeDb({ body: ANSWERED, storagePath: null, linkUrl: null }),
    });
    expect(out?.body).toContain("Complete the gap");
    expect(out?.body).not.toContain("[!answer]");
    expect(out?.body).not.toContain("goes");
  });

  it("passes the file/link pieces of the same row through untouched", async () => {
    const out = await getStudentClassContent("b1", {
      db: fakeDb({ body: ANSWERED, storagePath: "t1/x.pdf", linkUrl: "https://x/y" }),
    });
    expect(out?.storagePath).toBe("t1/x.pdf");
    expect(out?.linkUrl).toBe("https://x/y");
  });

  it("leaves a body with no answer key byte-identical", async () => {
    const body = "# Lesson\n\n> [!tip]\n> Read it aloud.";
    const out = await getStudentClassContent("b1", {
      db: fakeDb({ body, storagePath: null, linkUrl: null }),
    });
    expect(out?.body).toBe(body);
  });

  it("returns an empty body — not null — when the whole content was an answer key", async () => {
    // Null would read as "no class content" and hide the card entirely; the
    // material does exist, it just has nothing left for the student.
    const out = await getStudentClassContent("b1", {
      db: fakeDb({ body: "> [!answer]\n> 42", storagePath: null, linkUrl: null }),
    });
    expect(out?.body).toBe("");
  });

  it("returns null when the booking has no content material", async () => {
    expect(await getStudentClassContent("b1", { db: fakeDb(null) })).toBeNull();
  });
});
