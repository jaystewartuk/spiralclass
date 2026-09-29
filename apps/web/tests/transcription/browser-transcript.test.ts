import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lesson transcript written by the participants' browsers (D-189):
// consent decided server-side per class, one atomic append per line so two
// browsers cannot lose each other's lines, and a finalise that runs once
// whichever of the two completion signals (webhook, fallback job) arrives
// second — and drops a line that arrives after it.

vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  BROWSER_TRANSCRIPT_LIVE,
  BROWSER_TRANSCRIPT_PROVIDER,
  MAX_LINE_DURATION_MS,
  appendBrowserTranscriptLine,
  finalizeBrowserTranscript,
  lessonTranscriptCaptureOk,
  lineToUtterance,
} = await import("@/lib/transcription/browser-transcript");

beforeEach(() => {
  vi.stubEnv("LESSON_INSIGHTS_TRANSCRIPTION_ENABLED", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lessonTranscriptCaptureOk", () => {
  const booking = { teacherId: "t1", studentId: "s1" };
  const consented = { isMinor: false, insightsConsentAt: new Date(), guardianConsentAt: null };
  const db = (row: unknown) => ({
    teacherStudent: { findUnique: vi.fn(async () => row) },
  });

  it("is off while the flag is off, before any lookup", async () => {
    vi.stubEnv("LESSON_INSIGHTS_TRANSCRIPTION_ENABLED", "");
    const d = db(consented);
    expect(await lessonTranscriptCaptureOk(d as never, booking)).toBe(false);
    expect(d.teacherStudent.findUnique).not.toHaveBeenCalled();
  });

  it("keeps the transcript for a pairing with recorded insights consent", async () => {
    const d = db(consented);
    expect(await lessonTranscriptCaptureOk(d as never, booking)).toBe(true);
    expect(d.teacherStudent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId_studentId: { teacherId: "t1", studentId: "s1" } },
      }),
    );
  });

  it("FAILS CLOSED on a missing pairing, and on a minor with only her own consent", async () => {
    expect(await lessonTranscriptCaptureOk(db(null) as never, booking)).toBe(false);
    expect(
      await lessonTranscriptCaptureOk(
        db({ isMinor: true, insightsConsentAt: new Date(), guardianConsentAt: null }) as never,
        booking,
      ),
    ).toBe(false);
  });

  it("needs the buyer's confirmation for the second person of a class for two (D-188)", async () => {
    const forTwo = { ...booking, package: { seats: 2, partnerConsentAt: null } };
    expect(await lessonTranscriptCaptureOk(db(consented) as never, forTwo)).toBe(false);
    const confirmed = { ...booking, package: { seats: 2, partnerConsentAt: new Date() } };
    expect(await lessonTranscriptCaptureOk(db(consented) as never, confirmed)).toBe(true);
  });
});

describe("lineToUtterance", () => {
  it("stores Phase B's utterance shape, ending at receipt and starting the estimated duration earlier", () => {
    expect(
      lineToUtterance({ speaker: "student", text: "  hola  ", durationMs: 1_500 }, 10_000),
    ).toEqual({ speaker: "student", text: "hola", startMs: 8_500, endMs: 10_000, words: [] });
  });

  it("caps a duration a recogniser held back, and refuses a negative one", () => {
    const capped = lineToUtterance({ speaker: "teacher", text: "x", durationMs: 999_999 }, 10 ** 6);
    expect(capped.endMs - capped.startMs).toBe(MAX_LINE_DURATION_MS);
    const negative = lineToUtterance({ speaker: "teacher", text: "x", durationMs: -5 }, 100);
    expect(negative.startMs).toBe(100);
  });
});

describe("appendBrowserTranscriptLine", () => {
  // Captures the SQL text and the bound values of the tagged-template query.
  function fakeDb(rows: { inserted: boolean }[]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return rows;
    });
    return { db: { $queryRaw } as never, calls };
  }
  const line = {
    bookingId: "b1",
    teacherId: "t1",
    speaker: "teacher" as const,
    text: "Buenos días",
    durationMs: 2_000,
    now: 50_000,
  };

  it("appends atomically, scoped to the teacher, and only while the row is live", async () => {
    const { db, calls } = fakeDb([{ inserted: false }]);
    expect(await appendBrowserTranscriptLine(db, line)).toEqual({ kept: true, started: false });
    const [{ sql, values }] = calls;
    expect(sql).toMatch(/INSERT INTO lesson_transcripts/);
    expect(sql).toMatch(/ON CONFLICT \(booking_id\) DO UPDATE/);
    expect(sql).toMatch(/utterances = lesson_transcripts\.utterances \|\| EXCLUDED\.utterances/);
    expect(sql).toMatch(
      /WHERE lesson_transcripts\.provider = \?\s+AND lesson_transcripts\.teacher_id = \?::uuid/,
    );
    expect(sql).toMatch(/RETURNING \(xmax = 0\) AS inserted/);
    expect(values).toEqual([
      "b1",
      "t1",
      "es",
      JSON.stringify([
        { speaker: "teacher", text: "Buenos días", startMs: 48_000, endMs: 50_000, words: [] },
      ]),
      BROWSER_TRANSCRIPT_LIVE,
      BROWSER_TRANSCRIPT_LIVE,
      "t1",
    ]);
  });

  it("reports the first line of a class as the one that started the row", async () => {
    const { db } = fakeDb([{ inserted: true }]);
    expect(await appendBrowserTranscriptLine(db, line)).toEqual({ kept: true, started: true });
  });

  it("reports a line the database dropped (the class is finalised) as not kept", async () => {
    const { db } = fakeDb([]);
    expect(await appendBrowserTranscriptLine(db, line)).toEqual({ kept: false, started: false });
  });

  it("stores nothing for a blank line", async () => {
    const { db, calls } = fakeDb([{ inserted: true }]);
    expect(await appendBrowserTranscriptLine(db, { ...line, text: "   " })).toEqual({
      kept: false,
      started: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("finalizeBrowserTranscript", () => {
  const utterances = [
    { speaker: "teacher", text: "a", startMs: 10_000, endMs: 11_000, words: [] },
    { speaker: "student", text: "b", startMs: 12_000, endMs: 13_500, words: [] },
  ];
  function fakeDb(row: unknown, updatedCount = 1) {
    const findUnique = vi.fn(async () => row);
    const updateMany = vi.fn(async () => ({ count: updatedCount }));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    return {
      db: { lessonTranscript: { findUnique, updateMany, deleteMany } } as never,
      findUnique,
      updateMany,
      deleteMany,
    };
  }
  const inngest = { send: vi.fn(async () => ({ ids: [] })) };
  beforeEach(() => inngest.send.mockClear());

  it("rebases the timeline to 0, marks the row final and tells Phase C", async () => {
    const { db, updateMany } = fakeDb({
      id: "lt1",
      teacherId: "t1",
      provider: BROWSER_TRANSCRIPT_LIVE,
      utterances,
    });
    expect(await finalizeBrowserTranscript(db, inngest, "b1")).toEqual({
      code: "finalized",
      utteranceCount: 2,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "lt1", teacherId: "t1", provider: BROWSER_TRANSCRIPT_LIVE },
      data: {
        provider: BROWSER_TRANSCRIPT_PROVIDER,
        utterances: [
          { speaker: "teacher", text: "a", startMs: 0, endMs: 1_000, words: [] },
          { speaker: "student", text: "b", startMs: 2_000, endMs: 3_500, words: [] },
        ],
      },
    });
    expect(inngest.send).toHaveBeenCalledWith({
      name: "lesson.transcript.ready",
      data: { bookingId: "b1" },
    });
  });

  it("does nothing for a booking with no transcript, or one the egress pipeline wrote", async () => {
    expect(await finalizeBrowserTranscript(fakeDb(null).db, inngest, "b1")).toEqual({
      code: "skipped",
      reason: "no-live-transcript",
    });
    const deepgram = fakeDb({ id: "lt1", teacherId: "t1", provider: "deepgram", utterances });
    expect(await finalizeBrowserTranscript(deepgram.db, inngest, "b1")).toEqual({
      code: "skipped",
      reason: "already-final",
    });
    expect(deepgram.updateMany).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("fires Phase C once when the webhook and the fallback race (the guard lost)", async () => {
    const { db } = fakeDb(
      { id: "lt1", teacherId: "t1", provider: BROWSER_TRANSCRIPT_LIVE, utterances },
      0,
    );
    expect(await finalizeBrowserTranscript(db, inngest, "b1")).toEqual({
      code: "skipped",
      reason: "already-final",
    });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("deletes an empty live row instead of analysing nothing", async () => {
    const { db, deleteMany, updateMany } = fakeDb({
      id: "lt1",
      teacherId: "t1",
      provider: BROWSER_TRANSCRIPT_LIVE,
      utterances: [],
    });
    expect(await finalizeBrowserTranscript(db, inngest, "b1")).toEqual({
      code: "skipped",
      reason: "empty",
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "lt1", teacherId: "t1", provider: BROWSER_TRANSCRIPT_LIVE },
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
