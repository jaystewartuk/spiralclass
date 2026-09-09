import { beforeEach, describe, expect, it, vi } from "vitest";

// Lesson-insights consent gate (D-22): startCallRecording must NOT start the
// per-participant insights audio capture unless a recorded consent exists for
// the (teacher, student) pair — while the A/V recording itself proceeds either
// way. The pure consent predicate runs for real; everything with I/O is mocked.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })) }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/video/provider", () => ({ classCallRoom: (id: string) => `room-${id}` }));

const recordingEnabled = vi.fn(() => true);
const startRoomRecording = vi.fn(async (_room: any, _key: any) => ({ egressId: "eg1" }));
const stopRoomRecording = vi.fn(async (_id: any) => {});
vi.mock("@/lib/video/recording", () => ({
  recordingEnabled: () => recordingEnabled(),
  startRoomRecording: (...a: unknown[]) => startRoomRecording(...(a as [any, any])),
  stopRoomRecording: (...a: unknown[]) => stopRoomRecording(...(a as [any])),
  callRecordingKey: (bookingId: string, token: string) => `recordings/${bookingId}/${token}.m4a`,
}));

const startLessonAudioCaptures = vi.fn(async (_db: any, _args: any) => 1);
const stopLessonAudioCaptures = vi.fn(async (_db: any, _bookingId: any) => {});
vi.mock("@/lib/video/lesson-audio", () => ({
  startLessonAudioCaptures: (...a: unknown[]) => startLessonAudioCaptures(...(a as [any, any])),
  stopLessonAudioCaptures: (...a: unknown[]) => stopLessonAudioCaptures(...(a as [any, any])),
}));

const bookingFindFirst = vi.fn();
const teacherStudentFindUnique = vi.fn();
const callRecordingFindFirst = vi.fn();
const callRecordingCreate = vi.fn(async (_a: any) => ({}));
const callRecordingUpdate = vi.fn(async (_a: any) => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findFirst: (...a: unknown[]) => bookingFindFirst(...(a as [])) },
    teacherStudent: { findUnique: (...a: unknown[]) => teacherStudentFindUnique(...(a as [any])) },
    callRecording: {
      findFirst: (...a: unknown[]) => callRecordingFindFirst(...(a as [])),
      create: (...a: unknown[]) => callRecordingCreate(...(a as [any])),
      update: (...a: unknown[]) => callRecordingUpdate(...(a as [any])),
    },
  },
}));

const { startCallRecording } = await import("@/app/actions/call-recording");

const T = new Date("2026-06-25T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  recordingEnabled.mockReturnValue(true);
  startRoomRecording.mockResolvedValue({ egressId: "eg1" });
  bookingFindFirst.mockResolvedValue({ id: "b1", studentId: "s1" });
  callRecordingFindFirst.mockResolvedValue(null);
  teacherStudentFindUnique.mockResolvedValue({
    isMinor: false,
    insightsConsentAt: null,
    guardianConsentAt: null,
  });
});

describe("startCallRecording — insights consent gate (D-22)", () => {
  it("records A/V but SKIPS insights capture when no consent is on file", async () => {
    const res = await startCallRecording("b1");
    expect(res).toEqual({ ok: true });
    expect(startRoomRecording).toHaveBeenCalledOnce(); // A/V recording proceeds
    expect(startLessonAudioCaptures).not.toHaveBeenCalled(); // capture gated off
  });

  it("starts insights capture once adult consent is recorded", async () => {
    teacherStudentFindUnique.mockResolvedValueOnce({
      isMinor: false,
      insightsConsentAt: T,
      guardianConsentAt: null,
    });
    const res = await startCallRecording("b1");
    expect(res).toEqual({ ok: true });
    expect(startLessonAudioCaptures).toHaveBeenCalledOnce();
  });

  it("does NOT start capture for a minor on the student's own consent alone", async () => {
    teacherStudentFindUnique.mockResolvedValueOnce({
      isMinor: true,
      insightsConsentAt: T,
      guardianConsentAt: null,
    });
    await startCallRecording("b1");
    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });

  it("starts capture for a minor once guardian consent is recorded", async () => {
    teacherStudentFindUnique.mockResolvedValueOnce({
      isMinor: true,
      insightsConsentAt: null,
      guardianConsentAt: T,
    });
    await startCallRecording("b1");
    expect(startLessonAudioCaptures).toHaveBeenCalledOnce();
  });

  it("skips capture when the pairing row is missing entirely", async () => {
    teacherStudentFindUnique.mockResolvedValueOnce(null);
    const res = await startCallRecording("b1");
    expect(res).toEqual({ ok: true });
    expect(startLessonAudioCaptures).not.toHaveBeenCalled();
  });
});

describe("startCallRecording — self-heals a stale recording row", () => {
  it("completes a stale row + stops its egress, then starts fresh (no more deadlock)", async () => {
    // A prior egress ended without a Stop tap → the row is stuck on "recording".
    callRecordingFindFirst.mockResolvedValueOnce({ id: "old", egressId: "eg_old" });

    const res = await startCallRecording("b1");

    expect(res).toEqual({ ok: true });
    // The stale egress is stopped and its row completed...
    expect(stopRoomRecording).toHaveBeenCalledWith("eg_old");
    expect(callRecordingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old" },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
    // ...then a fresh recording starts (the button is no longer stuck).
    expect(startRoomRecording).toHaveBeenCalledOnce();
    expect(callRecordingCreate).toHaveBeenCalledOnce();
  });

  it("still starts when the stale egress can't be stopped (best-effort)", async () => {
    callRecordingFindFirst.mockResolvedValueOnce({ id: "old", egressId: "eg_old" });
    stopRoomRecording.mockRejectedValueOnce(new Error("egress gone"));

    const res = await startCallRecording("b1");
    expect(res).toEqual({ ok: true });
    expect(callRecordingUpdate).toHaveBeenCalled();
    expect(startRoomRecording).toHaveBeenCalledOnce();
  });
});
