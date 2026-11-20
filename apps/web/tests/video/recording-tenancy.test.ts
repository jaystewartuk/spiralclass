import { beforeEach, describe, expect, it, vi } from "vitest";

// Tenant scoping of the CallRecording writes in lib/video/call-recording.ts
// (#62, D-175). Each write used to find its row by id alone, correct only
// because of the read just before it. The fake below honours `teacherId` and
// `booking: { teacherId }` the way Prisma does, and `update` throws when its
// `where` matches nothing (P2025), so a write that names the wrong tenant
// cannot quietly succeed here either.

const stopRoomRecording = vi.fn(async (_id: string) => {});
vi.mock("@/lib/video/recording", () => ({
  recordingEnabled: () => true,
  startRoomRecording: vi.fn(async () => ({ egressId: "eg-new", storageKey: "k" })),
  stopRoomRecording: (...a: unknown[]) => stopRoomRecording(...(a as [string])),
  callRecordingKey: (bookingId: string, token: string) => `recordings/${bookingId}/${token}.m4a`,
}));
vi.mock("@/lib/video/lesson-audio", () => ({
  startLessonAudioCaptures: vi.fn(async () => 0),
  stopLessonAudioCaptures: vi.fn(async () => {}),
}));
vi.mock("@/lib/subscriptions/enforce", () => ({ gateProFeature: async () => ({ ok: true }) }));
vi.mock("@/lib/video/provider", () => ({
  classCallRoom: (id: string) => `room-${id}`,
  getVideoProvider: () => ({ recordingConfigured: () => true }),
}));
vi.mock("@/lib/lesson-notes/consent", () => ({ lessonInsightsConsentOk: () => false }));
vi.mock("@/lib/transcription/config", () => ({ transcriptionEnabled: () => true }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { startBookingRecording, stopBookingRecording, finalizeDanglingRecording } =
  await import("@/lib/video/call-recording");

const T1 = "teacher-1";
const T2 = "teacher-2";

type Booking = { id: string; teacherId: string; studentId: string };
type Rec = {
  id: string;
  bookingId: string;
  teacherId: string;
  egressId: string;
  status: string;
  endedAt: Date | null;
};
type Where = Record<string, unknown> & { booking?: { teacherId?: string } };

function makeDb() {
  const bookings: Booking[] = [
    { id: "b1", teacherId: T1, studentId: "s1" },
    { id: "b2", teacherId: T2, studentId: "s2" },
  ];
  const recordings: Rec[] = [];
  const bookingOf = (r: Rec) => bookings.find((b) => b.id === r.bookingId);
  const matches = (r: Rec, where: Where) =>
    (where.id === undefined || r.id === where.id) &&
    (where.bookingId === undefined || r.bookingId === where.bookingId) &&
    (where.status === undefined || r.status === where.status) &&
    (where.teacherId === undefined || r.teacherId === where.teacherId) &&
    (where.booking?.teacherId === undefined || bookingOf(r)?.teacherId === where.booking.teacherId);

  const callRecording = {
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const r = recordings.find((x) => matches(x, where));
      return r ? { ...r } : null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<Rec, "id" | "endedAt"> }) => {
      const r = { id: `rec-${recordings.length + 1}`, endedAt: null, ...data };
      recordings.push(r);
      return r;
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Partial<Rec> }) => {
      const r = recordings.find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      Object.assign(r, data);
      return r;
    }),
  };
  const prisma = {
    booking: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; teacherId: string } }) => {
        const b = bookings.find((x) => x.id === where.id && x.teacherId === where.teacherId);
        return b ? { ...b, student: { id: b.studentId, email: null }, package: null } : null;
      }),
    },
    teacherStudent: { findUnique: vi.fn(async () => null) },
    callRecording,
  };
  return { prisma, recordings, callRecording };
}

function seed(db: ReturnType<typeof makeDb>, rec: Partial<Rec> & Pick<Rec, "id" | "bookingId">) {
  db.recordings.push({
    teacherId: rec.bookingId === "b2" ? T2 : T1,
    egressId: `eg-${rec.id}`,
    status: "recording",
    endedAt: null,
    ...rec,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("startBookingRecording — stale-row self-heal names the teacher", () => {
  it("completes the stale row with a write scoped to the booking's teacher", async () => {
    const db = makeDb();
    seed(db, { id: "stale-1", bookingId: "b1" });

    const result = await startBookingRecording(db.prisma as never, T1, "b1");

    expect(result).toEqual({ ok: true });
    expect(db.callRecording.update).toHaveBeenCalledWith({
      where: { id: "stale-1", booking: { teacherId: T1 } },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(db.recordings.find((r) => r.id === "stale-1")?.status).toBe("completed");
  });

  it("does not complete another teacher's recording row", async () => {
    const db = makeDb();
    seed(db, { id: "other-teachers", bookingId: "b2" });
    // A read that handed back the wrong row: the write must not follow it.
    db.callRecording.findFirst.mockResolvedValueOnce({
      ...db.recordings[0],
    });

    await startBookingRecording(db.prisma as never, T1, "b1").catch(() => undefined);

    expect(db.recordings.find((r) => r.id === "other-teachers")?.status).toBe("recording");
  });
});

describe("stopBookingRecording — the Stop write names the teacher", () => {
  it("completes the active row with a write scoped to the booking's teacher", async () => {
    const db = makeDb();
    seed(db, { id: "rec-1", bookingId: "b1" });

    const result = await stopBookingRecording(db.prisma as never, T1, "b1");

    expect(result).toEqual({ ok: true });
    expect(db.callRecording.update).toHaveBeenCalledWith({
      where: { id: "rec-1", booking: { teacherId: T1 } },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(db.recordings[0].status).toBe("completed");
  });

  it("does not complete another teacher's recording row", async () => {
    const db = makeDb();
    seed(db, { id: "other-teachers", bookingId: "b2" });
    db.callRecording.findFirst.mockResolvedValueOnce({ ...db.recordings[0] });

    await stopBookingRecording(db.prisma as never, T1, "b1").catch(() => undefined);

    expect(db.recordings[0].status).toBe("recording");
  });
});

describe("finalizeDanglingRecording — the room_finished write names the row's teacher", () => {
  it("completes the dangling row with a write scoped to its own teacher", async () => {
    const db = makeDb();
    seed(db, { id: "rec-1", bookingId: "b1" });

    await finalizeDanglingRecording(db.prisma as never, "b1");

    expect(db.callRecording.update).toHaveBeenCalledWith({
      where: { id: "rec-1", teacherId: T1 },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(db.recordings[0].status).toBe("completed");
  });

  it("does not complete a row whose teacher is not the one it was read as", async () => {
    const db = makeDb();
    seed(db, { id: "other-teachers", bookingId: "b2" });
    db.callRecording.findFirst.mockResolvedValueOnce({ ...db.recordings[0], teacherId: T1 });

    await finalizeDanglingRecording(db.prisma as never, "b1").catch(() => undefined);

    expect(db.recordings[0].status).toBe("recording");
  });
});
