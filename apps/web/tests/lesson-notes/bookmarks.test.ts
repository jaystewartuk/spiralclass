import { describe, expect, it, vi } from "vitest";
import { computeBookmarkTimeline, createBookmark } from "@/lib/lesson-notes/bookmarks";

function fakePrisma(opts: { booking: { id: string } | null; lastPosition: number | null }) {
  return {
    booking: { findFirst: vi.fn(async () => opts.booking) },
    lessonNote: {
      findFirst: vi.fn(async () =>
        opts.lastPosition === null ? null : { position: opts.lastPosition },
      ),
      create: vi.fn(async (args: { data: unknown }) => ({
        id: "new-note",
        ...(args.data as object),
      })),
    },
  };
}

describe("createBookmark", () => {
  it("fails with not-found when the booking isn't owned by the teacher", async () => {
    const prisma = fakePrisma({ booking: null, lastPosition: null });
    const result = await createBookmark(prisma as any, {
      bookingId: "b1",
      teacherId: "t1",
      label: "Bookmark",
    });
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(prisma.lessonNote.create).not.toHaveBeenCalled();
  });

  it("appends after the last bookmark's position, scoped to kind=bookmark", async () => {
    const prisma = fakePrisma({ booking: { id: "b1" }, lastPosition: 2 });
    const result = await createBookmark(prisma as any, {
      bookingId: "b1",
      teacherId: "t1",
      label: "Bookmark",
    });
    expect(result).toEqual({ ok: true });
    expect(prisma.lessonNote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "b1", audience: "teacher", kind: "bookmark" },
      }),
    );
    expect(prisma.lessonNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "bookmark", audience: "teacher", position: 3 }),
      }),
    );
  });

  it("starts at position 0 when there's no prior bookmark", async () => {
    const prisma = fakePrisma({ booking: { id: "b1" }, lastPosition: null });
    await createBookmark(prisma as any, { bookingId: "b1", teacherId: "t1", label: "Bookmark" });
    expect(prisma.lessonNote.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 0 }) }),
    );
  });
});

describe("computeBookmarkTimeline", () => {
  it("returns null atMs for every bookmark when there's no recording timeline yet", () => {
    const result = computeBookmarkTimeline(
      [{ id: "1", body: "Bookmark", createdAt: new Date() }],
      [],
    );
    expect(result).toEqual([{ id: "1", label: "Bookmark", atMs: null }]);
  });

  it("rebases createdAt onto the earliest LessonAudio.startedAt, matching normalizeTimeline's basis", () => {
    const base = new Date("2026-07-20T10:00:00.000Z");
    const bookmarks = [
      { id: "1", body: "Bookmark", createdAt: new Date(base.getTime() + 5_000) },
      { id: "2", body: "Grammar slip", createdAt: new Date(base.getTime() + 42_000) },
    ];
    // Two speaker audio files starting a moment apart — the min is the basis.
    const audioStartedAts = [base, new Date(base.getTime() + 1_000)];
    const result = computeBookmarkTimeline(bookmarks, audioStartedAts);
    expect(result).toEqual([
      { id: "1", label: "Bookmark", atMs: 5_000 },
      { id: "2", label: "Grammar slip", atMs: 42_000 },
    ]);
  });

  it("clamps a bookmark that predates the recording basis to 0", () => {
    const base = new Date("2026-07-20T10:00:00.000Z");
    const result = computeBookmarkTimeline(
      [{ id: "1", body: "Bookmark", createdAt: new Date(base.getTime() - 2_000) }],
      [base],
    );
    expect(result[0]!.atMs).toBe(0);
  });
});
