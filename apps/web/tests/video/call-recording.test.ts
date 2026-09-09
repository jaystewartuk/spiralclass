import { beforeEach, describe, expect, it, vi } from "vitest";

// finalizeDanglingRecording — the room_finished-driven backstop for a booking's
// A/V recording that never got an explicit Stop tap (teacher navigated away, a
// crash, a dropped connection). Mirrors the stale-row self-heal in
// startBookingRecording, but runs proactively from the LiveKit webhook instead
// of waiting for the teacher's next Record attempt on that booking.

const stopRoomRecording = vi.fn(async (_id: string) => {});
vi.mock("@/lib/video/recording", () => ({
  recordingEnabled: () => true,
  startRoomRecording: vi.fn(),
  stopRoomRecording: (...a: unknown[]) => stopRoomRecording(...(a as [string])),
}));
const startLessonAudioCaptures = vi.fn(async () => 0);
vi.mock("@/lib/video/lesson-audio", () => ({
  startLessonAudioCaptures: (...a: unknown[]) => startLessonAudioCaptures(...(a as [])),
  stopLessonAudioCaptures: vi.fn(),
}));
vi.mock("@/lib/subscriptions/enforce", () => ({ gateProFeature: vi.fn() }));
const getVideoProvider = vi.fn((): { recordingConfigured: () => boolean } | null => ({
  recordingConfigured: () => true,
}));
vi.mock("@/lib/video/provider", () => ({
  classCallRoom: (id: string) => `room-${id}`,
  getVideoProvider: (...a: unknown[]) => getVideoProvider(...(a as [])),
}));
const lessonInsightsConsentOk = vi.fn((_consent?: unknown): boolean => true);
vi.mock("@/lib/lesson-notes/consent", () => ({
  lessonInsightsConsentOk: (...a: unknown[]) => lessonInsightsConsentOk(...(a as [unknown])),
}));
const transcriptionEnabled = vi.fn((): boolean => true);
vi.mock("@/lib/transcription/config", () => ({
  transcriptionEnabled: () => transcriptionEnabled(),
}));

const callRecordingFindFirst = vi.fn();
const callRecordingUpdate = vi.fn(async (_a: unknown) => ({}));
const bookingFindUnique = vi.fn();
const teacherStudentFindUnique = vi.fn();

const { finalizeDanglingRecording, maybeStartLessonAudioCapture } =
  await import("@/lib/video/call-recording");

const prisma = {
  callRecording: {
    findFirst: (...a: unknown[]) => callRecordingFindFirst(...(a as [])),
    update: (...a: unknown[]) => callRecordingUpdate(...(a as [unknown])),
  },
  booking: { findUnique: (...a: unknown[]) => bookingFindUnique(...(a as [])) },
  teacherStudent: { findUnique: (...a: unknown[]) => teacherStudentFindUnique(...(a as [])) },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  getVideoProvider.mockReturnValue({ recordingConfigured: () => true });
  lessonInsightsConsentOk.mockReturnValue(true);
});

describe("finalizeDanglingRecording", () => {
  it("no-ops when nothing is marked recording for the booking", async () => {
    callRecordingFindFirst.mockResolvedValueOnce(null);
    await finalizeDanglingRecording(prisma, "b1");
    expect(stopRoomRecording).not.toHaveBeenCalled();
    expect(callRecordingUpdate).not.toHaveBeenCalled();
  });

  it("stops the egress and marks the row completed when one is dangling", async () => {
    callRecordingFindFirst.mockResolvedValueOnce({ id: "rec1", egressId: "eg1" });
    await finalizeDanglingRecording(prisma, "b1");
    expect(stopRoomRecording).toHaveBeenCalledWith("eg1");
    expect(callRecordingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rec1" },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("still finalizes the row even if the egress stop call fails (best-effort)", async () => {
    callRecordingFindFirst.mockResolvedValueOnce({ id: "rec1", egressId: "eg1" });
    stopRoomRecording.mockRejectedValueOnce(new Error("egress already gone"));
    await finalizeDanglingRecording(prisma, "b1");
    expect(callRecordingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    );
  });
});

describe("maybeStartLessonAudioCapture", () => {
  const booking = { id: "b1", teacherId: "t1", studentId: "s1" };
  const consentedLink = { isMinor: false, insightsConsentAt: new Date(), guardianConsentAt: null };

  // The transcription gate (D-114). Before this, transcription-off only stopped the
  // audio at the ASR step — it had already been captured and uploaded to R2,
  // so "transcription off" still meant "student voice recorded".
  it("no-ops when transcription is disabled, even with a configured provider and consent", async () => {
    transcriptionEnabled.mockReturnValueOnce(false);

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(bookingFindUnique).not.toHaveBeenCalled();
    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("starts capture when the provider can record and consent is on record — regardless of CLASS_RECORDING_ENABLED", async () => {
    bookingFindUnique.mockResolvedValueOnce(booking);
    teacherStudentFindUnique.mockResolvedValueOnce(consentedLink);

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(startLessonAudioCaptures).toHaveBeenCalledWith(prisma, {
      bookingId: "b1",
      teacherId: "t1",
      studentId: "s1",
      room: "room-b1",
    });
  });

  it("no-ops when the provider isn't configured to record", async () => {
    getVideoProvider.mockReturnValueOnce({ recordingConfigured: () => false });

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(bookingFindUnique).not.toHaveBeenCalled();
    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("no-ops when there's no provider at all", async () => {
    getVideoProvider.mockReturnValueOnce(null);

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("no-ops when insights consent isn't on record", async () => {
    bookingFindUnique.mockResolvedValueOnce(booking);
    teacherStudentFindUnique.mockResolvedValueOnce({
      isMinor: false,
      insightsConsentAt: null,
      guardianConsentAt: null,
    });
    lessonInsightsConsentOk.mockReturnValueOnce(false);

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("no-ops when there's no teacher-student pairing on record", async () => {
    bookingFindUnique.mockResolvedValueOnce(booking);
    teacherStudentFindUnique.mockResolvedValueOnce(null);

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("no-ops when the booking doesn't exist", async () => {
    bookingFindUnique.mockResolvedValueOnce(null);

    await maybeStartLessonAudioCapture(prisma, "b1");

    expect(teacherStudentFindUnique).not.toHaveBeenCalled();
    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("swallows a capture-start failure (best-effort, called from a webhook)", async () => {
    bookingFindUnique.mockResolvedValueOnce(booking);
    teacherStudentFindUnique.mockResolvedValueOnce(consentedLink);
    startLessonAudioCaptures.mockRejectedValueOnce(new Error("livekit boom"));

    await expect(maybeStartLessonAudioCapture(prisma, "b1")).resolves.toBeUndefined();
  });
});
