import { beforeEach, describe, expect, it, vi } from "vitest";

// maybeAutoStartRecording (D-132) — the `participant_joined` entry point that
// starts a class's recording for a teacher who opted into autoRecordClasses,
// so a recording (and the insights pipeline downstream of it) no longer hangs
// off her remembering to tap Record mid-lesson.
//
// The behaviour worth pinning here is the set of things it refuses to do:
// record a teacher sitting alone in her own waiting room, restart a recording
// she deliberately stopped, or throw into a webhook. startBookingRecording is
// deliberately NOT mocked — it is the whole point that auto-start reuses the
// real gate chain (Pro, recordingEnabled, D-22 consent) rather than a parallel
// one, so these tests run through it.

const recordingEnabled = vi.fn((): boolean => true);
const startRoomRecording = vi.fn(async (_room: string, _key: string) => ({
  egressId: "eg1",
  storageKey: "k",
}));
vi.mock("@/lib/video/recording", () => ({
  recordingEnabled: () => recordingEnabled(),
  startRoomRecording: (...a: unknown[]) => startRoomRecording(...(a as [string, string])),
  stopRoomRecording: vi.fn(async () => {}),
  callRecordingKey: (bookingId: string, token: string) => `recordings/${bookingId}/${token}.m4a`,
}));

const listRoomParticipantIdentities = vi.fn(async (_room: string): Promise<string[]> => []);
vi.mock("@/lib/video/room", () => ({
  listRoomParticipantIdentities: (...a: unknown[]) =>
    listRoomParticipantIdentities(...(a as [string])),
}));

const startLessonAudioCaptures = vi.fn(async () => 0);
vi.mock("@/lib/video/lesson-audio", () => ({
  startLessonAudioCaptures: (...a: unknown[]) => startLessonAudioCaptures(...(a as [])),
  stopLessonAudioCaptures: vi.fn(),
}));

const gateProFeature = vi.fn(async () => ({ ok: true }) as { ok: boolean; limit?: number });
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...a: unknown[]) => gateProFeature(...(a as [])),
}));

vi.mock("@/lib/video/provider", () => ({
  classCallRoom: (id: string) => `room-${id}`,
  getVideoProvider: () => ({ recordingConfigured: () => true }),
}));

vi.mock("@/lib/lesson-notes/consent", () => ({ lessonInsightsConsentOk: () => true }));
vi.mock("@/lib/transcription/config", () => ({ transcriptionEnabled: () => true }));

const bookingFindUnique = vi.fn();
// startBookingRecording re-reads the booking with findFirst, scoped to the
// teacher; maybeAutoStartRecording reads it with findUnique first. Both are
// stubbed so the auto-start path runs the real gate chain end to end.
const bookingFindFirst = vi.fn();
const teacherFindUnique = vi.fn();
const teacherStudentFindUnique = vi.fn();
const callRecordingFindFirst = vi.fn();
const callRecordingCreate = vi.fn(async (_a: unknown) => ({}));
const callRecordingUpdate = vi.fn(async (_a: unknown) => ({}));

const { maybeAutoStartRecording } = await import("@/lib/video/call-recording");

const prisma = {
  booking: {
    findUnique: (...a: unknown[]) => bookingFindUnique(...(a as [])),
    findFirst: (...a: unknown[]) => bookingFindFirst(...(a as [])),
  },
  teacher: { findUnique: (...a: unknown[]) => teacherFindUnique(...(a as [])) },
  teacherStudent: { findUnique: (...a: unknown[]) => teacherStudentFindUnique(...(a as [])) },
  callRecording: {
    findFirst: (...a: unknown[]) => callRecordingFindFirst(...(a as [])),
    create: (...a: unknown[]) => callRecordingCreate(...(a as [unknown])),
    update: (...a: unknown[]) => callRecordingUpdate(...(a as [unknown])),
  },
} as never;

const BOOKING = { id: "b1", teacherId: "t1", studentId: "s1" };

beforeEach(() => {
  vi.clearAllMocks();
  recordingEnabled.mockReturnValue(true);
  bookingFindUnique.mockResolvedValue(BOOKING);
  bookingFindFirst.mockResolvedValue({ id: BOOKING.id, studentId: BOOKING.studentId });
  teacherFindUnique.mockResolvedValue({ autoRecordClasses: true });
  teacherStudentFindUnique.mockResolvedValue({
    isMinor: false,
    insightsConsentAt: new Date(),
    guardianConsentAt: null,
  });
  callRecordingFindFirst.mockResolvedValue(null);
  listRoomParticipantIdentities.mockResolvedValue(["t1", "s1"]);
  startRoomRecording.mockResolvedValue({ egressId: "eg1", storageKey: "k" });
  gateProFeature.mockResolvedValue({ ok: true });
});

describe("maybeAutoStartRecording", () => {
  it("starts the recording when both parties are in the room and the teacher opted in", async () => {
    await maybeAutoStartRecording(prisma, "b1");
    expect(startRoomRecording).toHaveBeenCalledOnce();
    expect(callRecordingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookingId: "b1", teacherId: "t1", status: "recording" }),
      }),
    );
  });

  it("does nothing when the teacher has not opted in", async () => {
    teacherFindUnique.mockResolvedValue({ autoRecordClasses: false });
    await maybeAutoStartRecording(prisma, "b1");
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  it("does nothing when class recording is not enabled for the environment", async () => {
    recordingEnabled.mockReturnValue(false);
    await maybeAutoStartRecording(prisma, "b1");
    expect(bookingFindUnique).not.toHaveBeenCalled();
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  // The waiting-room case: a teacher who opens the call early is not in a
  // class, and recording her alone is both useless and a real egress cost on a
  // 2-OCPU box.
  it("does not record a teacher waiting alone", async () => {
    listRoomParticipantIdentities.mockResolvedValue(["t1"]);
    await maybeAutoStartRecording(prisma, "b1");
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  it("does not record a student waiting alone", async () => {
    listRoomParticipantIdentities.mockResolvedValue(["s1"]);
    await maybeAutoStartRecording(prisma, "b1");
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  // The rule that makes Stop stick. Reconnects re-fire participant_joined all
  // the time, so guarding on "nothing is CURRENTLY recording" would quietly
  // restart a recording the teacher had just chosen to end. Any row at all —
  // completed included — means auto-start has had its one turn on this booking.
  it("never restarts after a recording already existed for the booking", async () => {
    callRecordingFindFirst.mockResolvedValue({ id: "rec1" });
    await maybeAutoStartRecording(prisma, "b1");
    expect(startRoomRecording).not.toHaveBeenCalled();
    // Cheaper check first: it should not even have asked who is in the room.
    expect(listRoomParticipantIdentities).not.toHaveBeenCalled();
  });

  it("respects the Pro gate that startBookingRecording owns", async () => {
    gateProFeature.mockResolvedValue({ ok: false, limit: 0 });
    await maybeAutoStartRecording(prisma, "b1");
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  it("no-ops for an unknown booking", async () => {
    bookingFindUnique.mockResolvedValue(null);
    await maybeAutoStartRecording(prisma, "nope");
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  // Called from the webhook route, so a failure must never become a webhook
  // error — LiveKit would retry the delivery and the call itself is unaffected.
  it("swallows a provider failure rather than throwing into the webhook", async () => {
    listRoomParticipantIdentities.mockRejectedValue(new Error("livekit down"));
    await expect(maybeAutoStartRecording(prisma, "b1")).resolves.toBeUndefined();
  });

  it("swallows a database failure too", async () => {
    teacherFindUnique.mockRejectedValue(new Error("db down"));
    await expect(maybeAutoStartRecording(prisma, "b1")).resolves.toBeUndefined();
  });
});
