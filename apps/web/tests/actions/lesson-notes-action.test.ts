import { beforeEach, describe, expect, it, vi } from "vitest";

// In-class live notes server actions (D-15). The security-relevant invariant is
// that every action is tenant-scoped: a teacher can only write notes on
// a booking they own, and can only edit/delete/reorder/toggle notes reachable
// through one of their own bookings. These tests pin the exact `where` clauses
// that enforce that, plus the per-action validation and ordering behaviour.

const state = {
  // ownedBookingId() lookup — the booking row when this teacher owns it, else null.
  ownedBooking: { id: "b1" } as { id: string } | null,
  // The "last note in the column" lookup that drives position append.
  lastNote: null as { position: number } | null,
  // The note resolved by update/delete/toggle/move (already tenant-scoped in the
  // query); null models "not found / not owned".
  note: null as {
    id: string;
    bookingId: string;
    audience?: string;
    position?: number;
    doneAt?: Date | null;
  } | null,
  // The neighbour resolved by moveLessonNote; null means the note is at an edge.
  neighbour: null as { id: string; position: number } | null,
};

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", timezone: "America/Mexico_City" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(),
}));
vi.mock("@/lib/date-display", () => ({
  formatZonedDateTime: vi.fn(() => "Jun 12, 2026, 10:00 AM"),
}));

// Pro gate + summary generator are mocked so the action's branching is what's
// under test, not Claude or the billing resolver.
const gateProFeature = vi.fn(async () => ({ ok: true }) as { ok: boolean; limit?: string });
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...args: unknown[]) => gateProFeature(...(args as [])),
  upgradeNudge: vi.fn(() => "Upgrade to Pro"),
}));

class SummaryUnavailableError extends Error {}
const generateSummaryText = vi.fn(async () => ({
  body: "A tidy recap.",
  model: "claude-haiku-4-5",
}));
vi.mock("@/lib/lesson-notes/summary", () => ({
  generateSummaryText: () => generateSummaryText(),
  SummaryUnavailableError,
}));

const bookingFindFirst = vi.fn(async () => state.ownedBooking);
const noteCreate = vi.fn(async () => ({ id: "n-new" }));
const noteUpdate = vi.fn(async () => ({}));
const noteDelete = vi.fn(async () => ({}));
// lessonNote.findFirst serves three call sites (last-position lookup in create,
// note lookup in update/delete/toggle, note + neighbour lookup in move). The
// `where` shape disambiguates which the action is asking for.
const noteFindFirst = vi.fn(async (args: { where: Record<string, unknown> }) => {
  if ("audience" in args.where && "position" in args.where) return state.neighbour; // move neighbour
  if ("audience" in args.where && "bookingId" in args.where) return state.lastNote; // create append
  return state.note; // update/delete/toggle/move target
});
const transaction = vi.fn(async (ops: unknown[]) => ops);
const noteGroupBy = vi.fn(
  async () => [] as Array<{ audience: string; _max: { position: number | null } }>,
);
const noteCreateMany = vi.fn(async () => ({ count: 0 }));
const summaryUpsert = vi.fn(async () => ({ id: "sum1" }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findFirst: bookingFindFirst },
    lessonNote: {
      findFirst: noteFindFirst,
      create: noteCreate,
      update: noteUpdate,
      delete: noteDelete,
      groupBy: noteGroupBy,
      createMany: noteCreateMany,
    },
    lessonSummary: { upsert: summaryUpsert },
    $transaction: (ops: unknown[]) => transaction(ops),
  },
}));

const {
  createLessonNote,
  updateLessonNote,
  deleteLessonNote,
  toggleLessonNoteDone,
  moveLessonNote,
  copyNotesFromLastClass,
  generateLessonSummary,
} = await import("@/app/actions/lesson-notes");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.ownedBooking = { id: "b1" };
  state.lastNote = null;
  state.note = null;
  state.neighbour = null;
  gateProFeature.mockResolvedValue({ ok: true });
  generateSummaryText.mockResolvedValue({ body: "A tidy recap.", model: "claude-haiku-4-5" });
});

describe("createLessonNote", () => {
  it("rejects a missing/invalid audience before touching the DB", async () => {
    const res = await createLessonNote(undefined, fd({ bookingId: "b1", body: "hi" }));
    expect(res?.error).toBeTruthy();
    expect(bookingFindFirst).not.toHaveBeenCalled();
    expect(noteCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const res = await createLessonNote(
      undefined,
      fd({ bookingId: "b1", audience: "student", body: "   " }),
    );
    expect(res?.error).toBeTruthy();
    expect(noteCreate).not.toHaveBeenCalled();
  });

  it("refuses a booking the teacher doesn't own", async () => {
    state.ownedBooking = null;
    const res = await createLessonNote(
      undefined,
      fd({ bookingId: "b9", audience: "teacher", body: "warm up" }),
    );
    expect(res?.error).toBeTruthy();
    // ownership probe is scoped to the signed-in teacher
    expect(bookingFindFirst).toHaveBeenCalledWith({
      where: { id: "b9", teacherId: "t1" },
      select: { id: true },
    });
    expect(noteCreate).not.toHaveBeenCalled();
  });

  it("creates the first note at position 0, scoped to the teacher + booking", async () => {
    state.lastNote = null; // empty column
    const res = await createLessonNote(
      undefined,
      fd({ bookingId: "b1", audience: "teacher", body: "warm up" }),
    );
    expect(res?.ok).toBeTruthy();
    expect(noteCreate).toHaveBeenCalledWith({
      data: {
        bookingId: "b1",
        teacherId: "t1",
        audience: "teacher",
        body: "warm up",
        position: 0,
      },
      select: { id: true },
    });
  });

  it("appends after the last note in its own audience column", async () => {
    state.lastNote = { position: 4 };
    await createLessonNote(
      undefined,
      fd({ bookingId: "b1", audience: "student", body: "bring your book" }),
    );
    expect(noteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 5 }) }),
    );
  });

  it("truncates an over-long body to the 500-char cap", async () => {
    await createLessonNote(
      undefined,
      fd({ bookingId: "b1", audience: "student", body: "x".repeat(600) }),
    );
    expect(noteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body: "x".repeat(500) }) }),
    );
  });
});

describe("updateLessonNote", () => {
  it("is a no-op on an empty body (keeps the previous text)", async () => {
    await updateLessonNote(fd({ noteId: "n1", body: "  " }));
    expect(noteFindFirst).not.toHaveBeenCalled();
    expect(noteUpdate).not.toHaveBeenCalled();
  });

  it("resolves the note through the booking relation and does nothing when unowned", async () => {
    state.note = null;
    await updateLessonNote(fd({ noteId: "n1", body: "edited" }));
    expect(noteFindFirst).toHaveBeenCalledWith({
      where: { id: "n1", booking: { teacherId: "t1" } },
      select: { id: true, bookingId: true },
    });
    expect(noteUpdate).not.toHaveBeenCalled();
  });

  it("updates a note the teacher owns", async () => {
    state.note = { id: "n1", bookingId: "b1" };
    await updateLessonNote(fd({ noteId: "n1", body: "edited" }));
    expect(noteUpdate).toHaveBeenCalledWith({ where: { id: "n1" }, data: { body: "edited" } });
  });
});

describe("deleteLessonNote", () => {
  it("refuses to delete a note the teacher doesn't own", async () => {
    state.note = null;
    await deleteLessonNote(fd({ noteId: "n1" }));
    expect(noteFindFirst).toHaveBeenCalledWith({
      where: { id: "n1", booking: { teacherId: "t1" } },
      select: { id: true, bookingId: true },
    });
    expect(noteDelete).not.toHaveBeenCalled();
  });

  it("deletes a note the teacher owns", async () => {
    state.note = { id: "n1", bookingId: "b1" };
    await deleteLessonNote(fd({ noteId: "n1" }));
    expect(noteDelete).toHaveBeenCalledWith({ where: { id: "n1" } });
  });
});

describe("toggleLessonNoteDone", () => {
  it("only matches teacher-audience notes owned by the teacher", async () => {
    state.note = null;
    await toggleLessonNoteDone(fd({ noteId: "n1" }));
    expect(noteFindFirst).toHaveBeenCalledWith({
      where: { id: "n1", audience: "teacher", booking: { teacherId: "t1" } },
      select: { id: true, bookingId: true, doneAt: true },
    });
    expect(noteUpdate).not.toHaveBeenCalled();
  });

  it("checks an un-done cue off (sets doneAt)", async () => {
    state.note = { id: "n1", bookingId: "b1", doneAt: null };
    await toggleLessonNoteDone(fd({ noteId: "n1" }));
    expect(noteUpdate).toHaveBeenCalledWith({
      where: { id: "n1" },
      data: { doneAt: expect.any(Date) },
    });
  });

  it("un-checks an already-done cue (clears doneAt)", async () => {
    state.note = { id: "n1", bookingId: "b1", doneAt: new Date() };
    await toggleLessonNoteDone(fd({ noteId: "n1" }));
    expect(noteUpdate).toHaveBeenCalledWith({ where: { id: "n1" }, data: { doneAt: null } });
  });
});

describe("moveLessonNote", () => {
  it("ignores an invalid direction", async () => {
    await moveLessonNote(fd({ noteId: "n1", direction: "sideways" }));
    expect(noteFindFirst).not.toHaveBeenCalled();
  });

  it("does nothing when the note isn't owned", async () => {
    state.note = null;
    await moveLessonNote(fd({ noteId: "n1", direction: "up" }));
    expect(transaction).not.toHaveBeenCalled();
  });

  it("is a no-op at the edge (no neighbour to swap with)", async () => {
    state.note = { id: "n1", bookingId: "b1", audience: "teacher", position: 0 };
    state.neighbour = null;
    await moveLessonNote(fd({ noteId: "n1", direction: "up" }));
    expect(transaction).not.toHaveBeenCalled();
  });

  it("swaps positions with the neighbour above when moving up", async () => {
    state.note = { id: "n2", bookingId: "b1", audience: "teacher", position: 1 };
    state.neighbour = { id: "n1", position: 0 };
    await moveLessonNote(fd({ noteId: "n2", direction: "up" }));
    // neighbour lookup searches for a smaller position, ordered desc (nearest above)
    expect(noteFindFirst).toHaveBeenLastCalledWith({
      where: { bookingId: "b1", audience: "teacher", position: { lt: 1 } },
      orderBy: { position: "desc" },
      select: { id: true, position: true },
    });
    const ops = transaction.mock.calls[0]![0] as unknown[];
    expect(ops).toHaveLength(2);
    expect(noteUpdate).toHaveBeenCalledWith({ where: { id: "n2" }, data: { position: 0 } });
    expect(noteUpdate).toHaveBeenCalledWith({ where: { id: "n1" }, data: { position: 1 } });
  });
});

describe("copyNotesFromLastClass", () => {
  const CUR = { id: "b2", studentId: "s1", scheduledStart: new Date("2026-06-23T15:00:00Z") };

  it("refuses a booking the teacher doesn't own", async () => {
    bookingFindFirst.mockResolvedValueOnce(null);
    const res = await copyNotesFromLastClass(undefined, fd({ bookingId: "b2" }));
    expect(res?.error).toBeTruthy();
    expect(noteCreateMany).not.toHaveBeenCalled();
  });

  it("reports when there's no earlier class with notes", async () => {
    bookingFindFirst.mockResolvedValueOnce(CUR); // current
    bookingFindFirst.mockResolvedValueOnce(null); // no source
    const res = await copyNotesFromLastClass(undefined, fd({ bookingId: "b2" }));
    expect(res?.error).toBeTruthy();
    expect(noteCreateMany).not.toHaveBeenCalled();
  });

  it("appends both columns after the current tails, resetting done", async () => {
    bookingFindFirst.mockResolvedValueOnce(CUR);
    bookingFindFirst.mockResolvedValueOnce({
      lessonNotes: [
        { audience: "teacher", body: "cue A", position: 0 },
        { audience: "teacher", body: "cue B", position: 1 },
        { audience: "student", body: "hw", position: 0 },
      ],
    } as never);
    // Current booking already has one teacher note (max position 0) and no student notes.
    noteGroupBy.mockResolvedValueOnce([{ audience: "teacher", _max: { position: 0 } }]);

    const res = await copyNotesFromLastClass(undefined, fd({ bookingId: "b2" }));
    expect(res?.ok).toBeTruthy();
    expect(noteCreateMany).toHaveBeenCalledWith({
      data: [
        { bookingId: "b2", teacherId: "t1", audience: "teacher", body: "cue A", position: 1 },
        { bookingId: "b2", teacherId: "t1", audience: "teacher", body: "cue B", position: 2 },
        { bookingId: "b2", teacherId: "t1", audience: "student", body: "hw", position: 0 },
      ],
    });
  });
});

describe("generateLessonSummary", () => {
  const past = new Date(Date.now() - 60 * 60_000);
  const future = new Date(Date.now() + 60 * 60_000);
  const withNotes = (start: Date) => ({
    id: "b1",
    scheduledStart: start,
    student: { name: "Marco" },
    lessonNotes: [
      { audience: "teacher", body: "review past tense", position: 0, doneAt: new Date() },
      { audience: "student", body: "hw: pages 4-6", position: 0, doneAt: null },
    ],
  });

  it("is Pro-gated — a Free teacher gets the upgrade nudge, no generation", async () => {
    gateProFeature.mockResolvedValueOnce({ ok: false, limit: "lesson_notes" });
    const res = await generateLessonSummary(undefined, fd({ bookingId: "b1" }));
    expect(res?.error).toBe("Upgrade to Pro");
    expect(generateSummaryText).not.toHaveBeenCalled();
    expect(summaryUpsert).not.toHaveBeenCalled();
  });

  it("refuses a booking the teacher doesn't own", async () => {
    bookingFindFirst.mockResolvedValueOnce(null);
    const res = await generateLessonSummary(undefined, fd({ bookingId: "b9" }));
    expect(res?.error).toBeTruthy();
    expect(generateSummaryText).not.toHaveBeenCalled();
  });

  it("won't summarize a class that hasn't started yet", async () => {
    bookingFindFirst.mockResolvedValueOnce(withNotes(future) as never);
    const res = await generateLessonSummary(undefined, fd({ bookingId: "b1" }));
    expect(res?.error).toBeTruthy();
    expect(generateSummaryText).not.toHaveBeenCalled();
  });

  it("won't summarize a class with no notes", async () => {
    bookingFindFirst.mockResolvedValueOnce({
      id: "b1",
      scheduledStart: past,
      student: { name: "Marco" },
      lessonNotes: [],
    } as never);
    const res = await generateLessonSummary(undefined, fd({ bookingId: "b1" }));
    expect(res?.error).toBeTruthy();
    expect(generateSummaryText).not.toHaveBeenCalled();
  });

  it("generates + upserts the summary for a started class with notes", async () => {
    bookingFindFirst.mockResolvedValueOnce(withNotes(past) as never);
    const res = await generateLessonSummary(undefined, fd({ bookingId: "b1" }));
    expect(res?.ok).toBeTruthy();
    expect(generateSummaryText).toHaveBeenCalled();
    expect(summaryUpsert).toHaveBeenCalledWith({
      where: { bookingId: "b1" },
      create: {
        bookingId: "b1",
        teacherId: "t1",
        body: "A tidy recap.",
        model: "claude-haiku-4-5",
      },
      update: { body: "A tidy recap.", model: "claude-haiku-4-5" },
    });
  });

  it("surfaces a friendly error when summaries are unavailable (no API key)", async () => {
    bookingFindFirst.mockResolvedValueOnce(withNotes(past) as never);
    generateSummaryText.mockRejectedValueOnce(new SummaryUnavailableError("no key"));
    const res = await generateLessonSummary(undefined, fd({ bookingId: "b1" }));
    expect(res?.error).toBeTruthy();
    expect(summaryUpsert).not.toHaveBeenCalled();
  });
});
