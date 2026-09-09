import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the orchestration module pulls in the real Inngest client, which
// reads serverEnv() at module load; stub it so the unit run needs no env. The
// functions under test take an injected `inngest` dep anyway.
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));

import {
  finalizeLessonAudio,
  speakerFor,
  startLessonAudioCaptures,
  stopLessonAudioCaptures,
  type LessonAudioDeps,
} from "@/lib/video/lesson-audio";

// Lesson insights Phase A orchestration.
// The DB + LiveKit + Inngest side effects are injected, so this exercises the
// pure mapping: participant identity → speaker, the per-participant egress start
// + row write, the egress_ended finalize (idempotent, emits exactly once), and
// the booking-wide stop sweep.

const TEACHER = "teacher-1";
const STUDENT = "student-1";
const BOOKING = "booking-1";
const ROOM = "class-booking-1";

type Row = {
  id: string;
  bookingId: string;
  teacherId: string;
  speaker: "student" | "teacher";
  egressId: string;
  storageKey: string;
  status: string;
  durationMs: number | null;
  endedAt: Date | null;
};

// Minimal in-memory prisma.lessonAudio delegate the functions under test use.
function makeDb() {
  const rows: Row[] = [];
  let seq = 0;
  return {
    rows,
    lessonAudio: {
      create: vi.fn(async ({ data }: any) => {
        const row: Row = {
          id: `audio-${++seq}`,
          durationMs: null,
          endedAt: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: any) => rows.find((r) => r.egressId === where.egressId) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.bookingId === where.bookingId &&
              r.speaker === where.speaker &&
              r.status === where.status,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter((r) => r.bookingId === where.bookingId && r.status === where.status),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = rows.filter(
          (r) => r.id === where.id && (where.status === undefined || r.status === where.status),
        );
        for (const r of matches) Object.assign(r, data);
        return { count: matches.length };
      }),
    },
  };
}

function makeDeps(over: Partial<LessonAudioDeps> = {}): LessonAudioDeps {
  let egressSeq = 0;
  return {
    listMicTracks: vi.fn(async () => [
      { identity: TEACHER, trackId: "TR_teacher" },
      { identity: STUDENT, trackId: "TR_student" },
    ]),
    startEgress: vi.fn(async (_room: string, _trackId: string, storageKey: string) => ({
      egressId: `EG_${++egressSeq}`,
      storageKey,
    })),
    stopEgress: vi.fn(async () => {}),
    inngest: { send: vi.fn(async () => ({ ids: [] }) as any) },
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("speakerFor", () => {
  it("maps the booking's teacher and student ids; null otherwise", () => {
    const booking = { teacherId: TEACHER, studentId: STUDENT };
    expect(speakerFor(TEACHER, booking)).toBe("teacher");
    expect(speakerFor(STUDENT, booking)).toBe("student");
    expect(speakerFor("someone-else", booking)).toBeNull();
  });
});

describe("startLessonAudioCaptures", () => {
  it("starts one egress per known participant and writes a recording row each", async () => {
    const db = makeDb();
    const deps = makeDeps();

    const started = await startLessonAudioCaptures(
      db as any,
      { bookingId: BOOKING, teacherId: TEACHER, studentId: STUDENT, room: ROOM },
      deps,
    );

    expect(started).toBe(2);
    expect(deps.startEgress).toHaveBeenCalledTimes(2);
    expect(db.rows.map((r) => r.speaker).sort()).toEqual(["student", "teacher"]);
    // Stored key matches what the egress was started with (LiveKit writes there).
    for (const row of db.rows) {
      expect(row.status).toBe("recording");
      expect(row.storageKey).toMatch(
        new RegExp(`^lesson-audio/${BOOKING}/${row.speaker}-\\d+\\.ogg$`),
      );
    }
  });

  it("skips participants that are neither the teacher nor the student", async () => {
    const db = makeDb();
    const deps = makeDeps({
      listMicTracks: vi.fn(async () => [
        { identity: TEACHER, trackId: "TR_teacher" },
        { identity: "ghost", trackId: "TR_ghost" },
      ]),
    });

    const started = await startLessonAudioCaptures(
      db as any,
      { bookingId: BOOKING, teacherId: TEACHER, studentId: STUDENT, room: ROOM },
      deps,
    );

    expect(started).toBe(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].speaker).toBe("teacher");
  });

  it("a failed egress for one participant doesn't abort the others", async () => {
    const db = makeDb();
    const startEgress = vi
      .fn()
      .mockRejectedValueOnce(new Error("livekit boom"))
      .mockResolvedValueOnce({ egressId: "EG_ok", storageKey: "k" });
    const deps = makeDeps({ startEgress });

    const started = await startLessonAudioCaptures(
      db as any,
      { bookingId: BOOKING, teacherId: TEACHER, studentId: STUDENT, room: ROOM },
      deps,
    );

    expect(started).toBe(1);
    expect(db.rows).toHaveLength(1);
  });

  it("skips a speaker that already has an active recording row (idempotent re-entry)", async () => {
    const db = makeDb();
    db.rows.push({
      id: "audio-existing",
      bookingId: BOOKING,
      teacherId: TEACHER,
      speaker: "teacher",
      egressId: "EG_existing",
      storageKey: "lesson-audio/booking-1/teacher-1.ogg",
      status: "recording",
      durationMs: null,
      endedAt: null,
    });
    const deps = makeDeps();

    const started = await startLessonAudioCaptures(
      db as any,
      { bookingId: BOOKING, teacherId: TEACHER, studentId: STUDENT, room: ROOM },
      deps,
    );

    // Only the student (no active row yet) gets a new capture; the teacher's
    // already-recording row is left alone and no duplicate egress is started.
    expect(started).toBe(1);
    expect(db.rows).toHaveLength(2);
    expect(deps.startEgress).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeLessonAudio", () => {
  function seedRecording(db: ReturnType<typeof makeDb>) {
    db.rows.push({
      id: "audio-1",
      bookingId: BOOKING,
      teacherId: TEACHER,
      speaker: "student",
      egressId: "EG_1",
      storageKey: "lesson-audio/booking-1/student-123.ogg",
      status: "recording",
      durationMs: null,
      endedAt: null,
    });
  }

  it("flips a recording row to ready, records duration, and emits the event once", async () => {
    const db = makeDb();
    seedRecording(db);
    const deps = makeDeps();

    const result = await finalizeLessonAudio(
      db as any,
      { egressId: "EG_1", durationMs: 42_000, failed: false },
      deps,
    );

    expect(result).toEqual({ code: "finalized", audioId: "audio-1", status: "ready" });
    expect(db.rows[0].status).toBe("ready");
    expect(db.rows[0].durationMs).toBe(42_000);
    expect(deps.inngest.send).toHaveBeenCalledWith({
      name: "lesson.audio.ready",
      data: {
        bookingId: BOOKING,
        audioId: "audio-1",
        speaker: "student",
        storageKey: "lesson-audio/booking-1/student-123.ogg",
      },
    });
  });

  it("is idempotent — a replayed egress_ended updates nothing and re-emits nothing", async () => {
    const db = makeDb();
    seedRecording(db);
    const deps = makeDeps();

    await finalizeLessonAudio(db as any, { egressId: "EG_1", durationMs: 1, failed: false }, deps);
    const second = await finalizeLessonAudio(
      db as any,
      { egressId: "EG_1", durationMs: 1, failed: false },
      deps,
    );

    expect(second).toEqual({ code: "ignored", reason: "already-finalized" });
    expect(deps.inngest.send).toHaveBeenCalledTimes(1);
  });

  it("marks a failed egress 'failed' and emits no ready event", async () => {
    const db = makeDb();
    seedRecording(db);
    const deps = makeDeps();

    const result = await finalizeLessonAudio(
      db as any,
      { egressId: "EG_1", durationMs: null, failed: true },
      deps,
    );

    expect(result).toEqual({ code: "finalized", audioId: "audio-1", status: "failed" });
    expect(db.rows[0].status).toBe("failed");
    expect(deps.inngest.send).not.toHaveBeenCalled();
  });

  it("ignores an egress id it doesn't track (e.g. the A/V composite)", async () => {
    const db = makeDb();
    const deps = makeDeps();

    const result = await finalizeLessonAudio(
      db as any,
      { egressId: "EG_unknown", durationMs: null, failed: false },
      deps,
    );

    expect(result).toEqual({ code: "ignored", reason: "untracked-egress" });
    expect(deps.inngest.send).not.toHaveBeenCalled();
  });
});

describe("stopLessonAudioCaptures", () => {
  it("stops every still-recording capture for the booking", async () => {
    const db = makeDb();
    db.rows.push(
      {
        id: "a",
        bookingId: BOOKING,
        teacherId: TEACHER,
        speaker: "teacher",
        egressId: "EG_a",
        storageKey: "k",
        status: "recording",
        durationMs: null,
        endedAt: null,
      },
      {
        id: "b",
        bookingId: BOOKING,
        teacherId: TEACHER,
        speaker: "student",
        egressId: "EG_b",
        storageKey: "k",
        status: "ready",
        durationMs: null,
        endedAt: null,
      },
    );
    const deps = makeDeps();

    await stopLessonAudioCaptures(db as any, BOOKING, deps);

    expect(deps.stopEgress).toHaveBeenCalledTimes(1);
    expect(deps.stopEgress).toHaveBeenCalledWith("EG_a");
  });

  it("a failed stop is swallowed (best-effort)", async () => {
    const db = makeDb();
    db.rows.push({
      id: "a",
      bookingId: BOOKING,
      teacherId: TEACHER,
      speaker: "teacher",
      egressId: "EG_a",
      storageKey: "k",
      status: "recording",
      durationMs: null,
      endedAt: null,
    });
    const deps = makeDeps({
      stopEgress: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(stopLessonAudioCaptures(db as any, BOOKING, deps)).resolves.toBeUndefined();
  });
});
