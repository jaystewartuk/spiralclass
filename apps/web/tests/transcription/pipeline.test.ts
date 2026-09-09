import { beforeEach, describe, expect, it, vi } from "vitest";

// processLessonAudioReady pulls in the Inngest client (serverEnv at load); stub
// it. The pipeline takes injected deps anyway.
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));

import { processLessonAudioReady, type TranscriptionDeps } from "@/lib/transcription/pipeline";
import type { TranscriptionResult } from "@/lib/transcription/types";

const BOOKING = "booking-1";
const TEACHER = "teacher-1";

type AudioRow = {
  id: string;
  bookingId: string;
  teacherId: string;
  speaker: "student" | "teacher";
  storageKey: string;
  status: string;
  startedAt: Date;
};

function makeDb(audio: AudioRow[], opts: { retentionOptIn?: boolean } = {}) {
  const transcripts: Record<
    string,
    {
      bookingId: string;
      teacherId: string;
      language: string;
      utterances: unknown;
      provider: string;
    }
  > = {};
  const find = (id: string) => audio.find((a) => a.id === id);

  const db = {
    lessonAudio: {
      findUnique: vi.fn(async ({ where }: any) => find(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = find(where.id);
        if (!row || (where.status && row.status !== where.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = find(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      count: vi.fn(
        async ({ where }: any) =>
          audio.filter((a) => a.bookingId === where.bookingId && where.status.in.includes(a.status))
            .length,
      ),
    },
    lessonTranscript: {
      findUnique: vi.fn(async ({ where }: any) => transcripts[where.bookingId] ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = transcripts[where.bookingId];
        transcripts[where.bookingId] = existing ? { ...existing, ...update } : create;
        return transcripts[where.bookingId];
      }),
      update: vi.fn(async ({ where, data }: any) => {
        transcripts[where.bookingId] = { ...transcripts[where.bookingId], ...data };
        return transcripts[where.bookingId];
      }),
    },
    teacher: {
      findUnique: vi.fn(async () => ({ lessonAudioRetentionOptIn: opts.retentionOptIn ?? false })),
    },
  };
  return { db, transcripts };
}

function makeDeps(db: any, over: Partial<TranscriptionDeps> = {}): TranscriptionDeps {
  const result: TranscriptionResult = {
    provider: "deepgram",
    utterances: [{ text: "hola", startMs: 0, endMs: 500, words: [] }],
  };
  return {
    prisma: db,
    provider: { vendor: "deepgram", transcribe: vi.fn(async () => result) },
    store: {
      presignedGetUrl: vi.fn(() => "https://r2.example/signed"),
      deleteObject: vi.fn(async () => {}),
    },
    inngest: { send: vi.fn(async () => ({}) as any) },
    ...over,
  };
}

function audioRow(over: Partial<AudioRow> = {}): AudioRow {
  return {
    id: "audio-s",
    bookingId: BOOKING,
    teacherId: TEACHER,
    speaker: "student",
    storageKey: "lesson-audio/booking-1/student-1.ogg",
    status: "ready",
    startedAt: new Date("2026-06-24T15:00:00Z"),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("processLessonAudioReady", () => {
  it("transcribes the first file but does not complete while the other is pending", async () => {
    const rows = [
      audioRow({ id: "audio-s", speaker: "student" }),
      audioRow({ id: "audio-t", speaker: "teacher", status: "ready" }),
    ];
    const { db, transcripts } = makeDb(rows);
    const deps = makeDeps(db);

    const out = await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-s",
      speaker: "student",
      storageKey: rows[0].storageKey,
    });

    expect(out).toMatchObject({
      code: "transcribed",
      transcriptComplete: false,
      audioRetained: false,
    });
    expect(transcripts[BOOKING].utterances).toHaveLength(1);
    expect(rows[0].status).toBe("deleted"); // discarded (opt-in false)
    expect(deps.inngest.send).not.toHaveBeenCalled(); // not complete → no transcript.ready
  });

  it("fires lesson.transcript.ready and rebases the timeline when the last file completes", async () => {
    const rows = [
      audioRow({ id: "audio-s", speaker: "student", status: "transcribed" }),
      audioRow({
        id: "audio-t",
        speaker: "teacher",
        status: "ready",
        startedAt: new Date("2026-06-24T15:00:10Z"),
      }),
    ];
    const { db, transcripts } = makeDb(rows);
    // Seed the student's already-merged utterance (absolute epoch ms).
    transcripts[BOOKING] = {
      bookingId: BOOKING,
      teacherId: TEACHER,
      language: "es",
      provider: "deepgram",
      utterances: [
        {
          speaker: "student",
          text: "hola",
          startMs: rows[0].startedAt.getTime(),
          endMs: rows[0].startedAt.getTime() + 500,
          words: [],
        },
      ],
    };
    const deps = makeDeps(db);

    const out = await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-t",
      speaker: "teacher",
      storageKey: rows[1].storageKey,
    });

    expect(out).toMatchObject({ code: "transcribed", transcriptComplete: true });
    expect(deps.inngest.send).toHaveBeenCalledWith({
      name: "lesson.transcript.ready",
      data: { bookingId: BOOKING },
    });
    // Rebased to 0-based: earliest utterance (student) is now at 0.
    const utts = transcripts[BOOKING].utterances as Array<{ speaker: string; startMs: number }>;
    expect(Math.min(...utts.map((u) => u.startMs))).toBe(0);
  });

  it("keeps the audio (no delete) when the teacher opted in to retention", async () => {
    const rows = [audioRow({ id: "audio-s", speaker: "student" })];
    const { db } = makeDb(rows, { retentionOptIn: true });
    const deps = makeDeps(db);

    const out = await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-s",
      speaker: "student",
      storageKey: rows[0].storageKey,
    });

    expect(out).toMatchObject({ audioRetained: true });
    expect(deps.store.deleteObject).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("transcribed"); // retained, not deleted
  });

  it("skips a row that isn't 'ready' (idempotent on replay)", async () => {
    const rows = [audioRow({ status: "transcribed" })];
    const { db } = makeDb(rows);
    const deps = makeDeps(db);

    const out = await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-s",
      speaker: "student",
      storageKey: rows[0].storageKey,
    });

    expect(out).toEqual({ code: "skipped", reason: "status-transcribed" });
    expect(deps.provider.transcribe).not.toHaveBeenCalled();
  });

  it("skips when the audio row is missing", async () => {
    const { db } = makeDb([]);
    const deps = makeDeps(db);
    const out = await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "nope",
      speaker: "student",
      storageKey: "k",
    });
    expect(out).toEqual({ code: "skipped", reason: "audio-not-found" });
  });

  // Phase D fold-in: pronunciation is scored for the STUDENT file, with the
  // already-minted audio URL + transcript as reference, BEFORE the discard.
  it("scores the student's pronunciation before discarding the audio", async () => {
    const rows = [audioRow({ id: "audio-s", speaker: "student" })];
    const { db } = makeDb(rows);
    const order: string[] = [];
    const scorePronunciation = vi.fn(async () => {
      order.push("score");
      return { code: "scored", weakWords: 1 } as const;
    });
    const deps = makeDeps(db, { scorePronunciation });
    (deps.store.deleteObject as any).mockImplementation(async () => {
      order.push("discard");
    });

    await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-s",
      speaker: "student",
      storageKey: rows[0].storageKey,
    });

    expect(scorePronunciation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        bookingId: BOOKING,
        audioUrl: "https://r2.example/signed",
        referenceText: "hola",
        language: "es",
      }),
    );
    expect(order).toEqual(["score", "discard"]); // scored before the audio is gone
  });

  it("does not score the teacher file", async () => {
    const rows = [audioRow({ id: "audio-t", speaker: "teacher" })];
    const { db } = makeDb(rows);
    const scorePronunciation = vi.fn(async () => ({ code: "skipped", reason: "x" }) as const);
    const deps = makeDeps(db, { scorePronunciation });
    await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-t",
      speaker: "teacher",
      storageKey: rows[0].storageKey,
    });
    expect(scorePronunciation).not.toHaveBeenCalled();
  });

  it("a scoring failure never blocks the transcript event or the discard", async () => {
    const rows = [audioRow({ id: "audio-s", speaker: "student" })];
    const { db } = makeDb(rows);
    const scorePronunciation = vi.fn(async () => {
      throw new Error("azure boom");
    });
    const deps = makeDeps(db, { scorePronunciation });

    const out = await processLessonAudioReady(deps, {
      bookingId: BOOKING,
      audioId: "audio-s",
      speaker: "student",
      storageKey: rows[0].storageKey,
    });

    expect(out.code).toBe("transcribed");
    expect(deps.inngest.send).toHaveBeenCalled(); // lesson.transcript.ready still fired
    expect(deps.store.deleteObject).toHaveBeenCalled(); // discard still ran
  });
});
