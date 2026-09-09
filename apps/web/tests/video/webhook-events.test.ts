import { beforeEach, describe, expect, it, vi } from "vitest";

// The provider-agnostic dispatch logic behind app/api/livekit/webhook/route.ts
// (docs/features/live-calls-video.md), tested directly
// against a NormalizedVideoEvent rather than through the HTTP route + a
// specific provider's signature verification — the route wiring itself is
// covered by tests/video/livekit-webhook.test.ts.

const callRecordingFindUnique = vi.fn(
  async () =>
    null as { id: string; bookingId: string; teacherId: string; endedAt: Date | null } | null,
);
const callRecordingUpdate = vi.fn(async () => ({}));
const bookingFindUnique = vi.fn(async () => ({ teacherId: "teacher-9" }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    callRecording: { findUnique: callRecordingFindUnique, update: callRecordingUpdate },
    booking: { findUnique: bookingFindUnique },
  },
}));

const finalizeLessonAudio = vi.fn(async () => ({
  code: "finalized",
  audioId: "a1",
  status: "ready",
}));
const stopLessonAudioCaptures = vi.fn(async () => {});
vi.mock("@/lib/video/lesson-audio", () => ({ finalizeLessonAudio, stopLessonAudioCaptures }));

const finalizeDanglingRecording = vi.fn(async () => {});
const maybeStartLessonAudioCapture = vi.fn(async () => {});
const maybeAutoStartRecording = vi.fn(async () => {});
vi.mock("@/lib/video/call-recording", () => ({
  finalizeDanglingRecording,
  maybeStartLessonAudioCapture,
  maybeAutoStartRecording,
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent }));

const { handleNormalizedEvent } = await import("@/lib/video/webhook-events");
const { prisma } = await import("@/lib/prisma");

beforeEach(() => {
  vi.clearAllMocks();
  callRecordingFindUnique.mockResolvedValue(null);
  bookingFindUnique.mockResolvedValue({ teacherId: "teacher-9" });
});

describe("handleNormalizedEvent — recording_ended", () => {
  it("finalizes a CallRecording (A/V) row when the id matches one, and tracks it", async () => {
    callRecordingFindUnique.mockResolvedValueOnce({
      id: "rec-1",
      bookingId: "booking-9",
      teacherId: "teacher-9",
      endedAt: null,
    });

    const outcome = await handleNormalizedEvent(prisma, {
      kind: "recording_ended",
      room: null,
      providerRecordingId: "EG_AV",
      failed: false,
      durationMs: null,
    });

    expect(outcome).toMatchObject({ code: "call-recording-finalized", failed: false });
    expect(callRecordingFindUnique).toHaveBeenCalledWith({
      where: { egressId: "EG_AV" },
      select: { id: true, bookingId: true, teacherId: true, endedAt: true },
    });
    expect(callRecordingUpdate).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(finalizeLessonAudio).not.toHaveBeenCalled();
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_recording_finished",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9", failed: false },
    });
  });

  // The production race this branch used to lose (2026-08-27). `room_finished`
  // fires at room close and finalizeDanglingRecording sweeps the row to
  // "completed"; `egress_ended` only lands once the file has uploaded — 3m2s
  // later for a real 51-minute class. The old `status: "recording"` filter meant
  // this lookup matched nothing by then, so the egress's own verdict was thrown
  // away and call_recording_finished never fired.
  it("still finalizes a row the room_finished sweep already moved off 'recording'", async () => {
    const sweptAt = new Date("2026-08-27T18:54:08Z");
    callRecordingFindUnique.mockResolvedValueOnce({
      id: "rec-swept",
      bookingId: "booking-9",
      teacherId: "teacher-9",
      endedAt: sweptAt,
    });

    const outcome = await handleNormalizedEvent(prisma, {
      kind: "recording_ended",
      room: null,
      providerRecordingId: "EG_late",
      failed: false,
      durationMs: 3_060_000,
    });

    expect(outcome).toMatchObject({ code: "call-recording-finalized" });
    // The sweep's timestamp is kept — it fired at room close, nearer the true
    // end of the recording than this upload-completion moment.
    expect(callRecordingUpdate).toHaveBeenCalledWith({
      where: { id: "rec-swept" },
      data: { status: "completed", endedAt: sweptAt },
    });
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "call_recording_finished" }),
    );
  });

  it("corrects an optimistically-swept row to failed when the egress actually failed", async () => {
    callRecordingFindUnique.mockResolvedValueOnce({
      id: "rec-swept",
      bookingId: "booking-9",
      teacherId: "teacher-9",
      endedAt: new Date("2026-08-27T18:54:08Z"),
    });

    await handleNormalizedEvent(prisma, {
      kind: "recording_ended",
      room: null,
      providerRecordingId: "EG_late",
      failed: true,
      durationMs: null,
    });

    // The sweep can only ever assume success; the egress knows better.
    expect(callRecordingUpdate).toHaveBeenCalledWith({
      where: { id: "rec-swept" },
      data: expect.objectContaining({ status: "failed" }),
    });
  });

  it("falls through to finalizeLessonAudio when no CallRecording row matches", async () => {
    callRecordingFindUnique.mockResolvedValueOnce(null);

    await handleNormalizedEvent(prisma, {
      kind: "recording_ended",
      room: null,
      providerRecordingId: "EG_audio",
      failed: true,
      durationMs: 5_000,
    });

    expect(finalizeLessonAudio).toHaveBeenCalledWith(prisma, {
      egressId: "EG_audio",
      durationMs: 5_000,
      failed: true,
    });
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});

describe("handleNormalizedEvent — room_finished", () => {
  it("sweeps dangling captures and recordings for a class room, and tracks call_room_finished", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "room_finished",
      room: "class-booking-9",
    });

    expect(outcome).toEqual({ code: "room-finished-swept", bookingId: "booking-9" });
    expect(stopLessonAudioCaptures).toHaveBeenCalledWith(prisma, "booking-9");
    expect(finalizeDanglingRecording).toHaveBeenCalledWith(prisma, "booking-9");
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_room_finished",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9" },
    });
  });

  it("ignores a non-class room", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "room_finished",
      room: "lobby",
    });

    expect(outcome).toEqual({ code: "ignored", reason: "not-a-class-room" });
    expect(stopLessonAudioCaptures).not.toHaveBeenCalled();
    expect(finalizeDanglingRecording).not.toHaveBeenCalled();
  });
});

describe("handleNormalizedEvent — unhandled", () => {
  it("ignores an event kind the app doesn't act on", async () => {
    const outcome = await handleNormalizedEvent(prisma, { kind: "unhandled", room: null });
    expect(outcome).toEqual({ code: "ignored", reason: "unhandled-event" });
  });
});

describe("handleNormalizedEvent — participant_joined", () => {
  it("auto-starts lesson-audio capture and tracks call_participant_joined", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "participant_joined",
      room: "class-booking-9",
      identity: "teacher-9",
    });

    expect(outcome).toEqual({ code: "lesson-audio-capture-checked", bookingId: "booking-9" });
    expect(maybeStartLessonAudioCapture).toHaveBeenCalledWith(prisma, "booking-9");
    // D-132: the auto-record check rides the same event, independently — the
    // two answer different questions and neither implies the other.
    expect(maybeAutoStartRecording).toHaveBeenCalledWith(prisma, "booking-9");
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_participant_joined",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9", role: "teacher" },
    });
  });

  it("resolves a non-teacher identity to role student", async () => {
    await handleNormalizedEvent(prisma, {
      kind: "participant_joined",
      room: "class-booking-9",
      identity: "student-1",
    });

    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_participant_joined",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9", role: "student" },
    });
  });

  it("ignores a non-class room", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "participant_joined",
      room: "lobby",
      identity: "x",
    });

    expect(outcome).toEqual({ code: "ignored", reason: "not-a-class-room" });
    expect(maybeStartLessonAudioCapture).not.toHaveBeenCalled();
    expect(maybeAutoStartRecording).not.toHaveBeenCalled();
  });
});

describe("handleNormalizedEvent — call-lifecycle analytics", () => {
  it("tracks call_started on room_started", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "room_started",
      room: "class-booking-9",
    });

    expect(outcome).toEqual({ code: "call-started-tracked", bookingId: "booking-9" });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_started",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9" },
    });
  });

  it("tracks call_participant_left with a resolved role", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "participant_left",
      room: "class-booking-9",
      identity: "teacher-9",
    });

    expect(outcome).toEqual({ code: "call-participant-left-tracked", bookingId: "booking-9" });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_participant_left",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9", role: "teacher" },
    });
  });

  it("tracks call_recording_started on egress_started", async () => {
    const outcome = await handleNormalizedEvent(prisma, {
      kind: "egress_started",
      room: "class-booking-9",
      providerRecordingId: "EG_new",
    });

    expect(outcome).toEqual({ code: "call-recording-started-tracked", bookingId: "booking-9" });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_recording_started",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9" },
    });
  });

  it("never throws when the booking lookup fails — analytics is best-effort", async () => {
    bookingFindUnique.mockRejectedValueOnce(new Error("db down"));

    await expect(
      handleNormalizedEvent(prisma, { kind: "room_started", room: "class-booking-9" }),
    ).resolves.toEqual({ code: "call-started-tracked", bookingId: "booking-9" });
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});
