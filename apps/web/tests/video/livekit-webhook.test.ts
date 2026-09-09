import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route test for /api/livekit/webhook — the async completion signal for
// lesson-insights Phase A. Verifies: dormant 503 without creds, 401 on a bad
// signature, dedup via the shared webhook_events log, egress_ended → finalize,
// and room_finished → stop sweep (both the lesson-audio captures AND any
// dangling A/V CallRecording). The finalize/stop logic itself is covered in
// lesson-audio.test.ts / call-recording.test.ts; here we assert the route wires
// the verified payload to them.

const receive = vi.fn();
// `new` on a vi.fn() mock forwards to its implementation since vitest 5, and an
// arrow function is not constructible — so these SDK client stubs are plain
// functions returning the stub object, which `new` then yields.
const WebhookReceiver = vi.fn(function () {
  return { receive };
});
const EgressStatus = {
  EGRESS_COMPLETE: 3,
  EGRESS_FAILED: 4,
  EGRESS_ABORTED: 5,
  EGRESS_LIMIT_REACHED: 6,
};
vi.mock("livekit-server-sdk", () => ({ WebhookReceiver, EgressStatus }));

const webhookEventCreate = vi.fn(async () => ({}));
const webhookEventDeleteMany = vi.fn(async () => ({ count: 1 }));
// On a P2002 (claim exists), recordWebhookEvent reads processedAt; default it to
// a completed claim so the duplicate test reads as a true duplicate.
const webhookEventFindUnique = vi.fn(async () => ({ processedAt: new Date() }));
const webhookEventUpdateMany = vi.fn(async () => ({ count: 0 }));
const callRecordingFindUnique = vi.fn(
  async () =>
    null as { id: string; bookingId: string; teacherId: string; endedAt: Date | null } | null,
);
const callRecordingUpdate = vi.fn(async () => ({}));
const bookingFindUnique = vi.fn(async () => ({ teacherId: "teacher-9" }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webhookEvent: {
      create: webhookEventCreate,
      deleteMany: webhookEventDeleteMany,
      findUnique: webhookEventFindUnique,
      updateMany: webhookEventUpdateMany,
    },
    callRecording: { findUnique: callRecordingFindUnique, update: callRecordingUpdate },
    // trackCallEvent resolves the booking's teacherId as PostHog's `teacher`
    // group key; without it every call-lifecycle event is silently swallowed by
    // its own best-effort catch, which would hide the egress_started fix.
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
vi.mock("@/lib/video/call-recording", () => ({
  finalizeDanglingRecording,
  maybeStartLessonAudioCapture,
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent }));

const { POST } = await import("@/app/api/livekit/webhook/route");

function post(body: unknown, auth = "signed-header"): Promise<Response> {
  const req = new Request("http://localhost/api/livekit/webhook", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Authorization: auth },
  });
  return POST(req as unknown as NextRequest);
}

beforeEach(() => {
  vi.clearAllMocks();
  webhookEventCreate.mockResolvedValue({});
  webhookEventFindUnique.mockResolvedValue({ processedAt: new Date() });
  webhookEventUpdateMany.mockResolvedValue({ count: 0 });
  callRecordingFindUnique.mockResolvedValue(null);
  // The route resolves the active provider via the same getVideoProvider()
  // every other video call site uses (docs/features/live-calls-video.md),
  // which needs all three LiveKit vars —
  // URL and API key are always provisioned together in practice (see
  // config/env/*.runtime.env); only the secret is separately Infisical-managed.
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
});
afterEach(() => {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
});

describe("POST /api/livekit/webhook", () => {
  it("503s when the video provider isn't configured", async () => {
    delete process.env.LIVEKIT_API_KEY;
    const res = await post({});
    expect(res.status).toBe(503);
    expect(receive).not.toHaveBeenCalled();
  });

  it("401s when the signature can't be verified", async () => {
    receive.mockRejectedValueOnce(new Error("bad sig"));
    const res = await post({});
    expect(res.status).toBe(401);
  });

  it("finalizes the capture on egress_ended and converts ns duration to ms", async () => {
    receive.mockResolvedValueOnce({
      id: "evt-1",
      event: "egress_ended",
      egressInfo: {
        egressId: "EG_1",
        status: EgressStatus.EGRESS_COMPLETE,
        fileResults: [{ duration: 42_000_000_000n }], // 42s in ns
      },
    });

    const res = await post({});
    expect(res.status).toBe(200);
    expect(finalizeLessonAudio).toHaveBeenCalledWith(expect.anything(), {
      egressId: "EG_1",
      durationMs: 42_000,
      failed: false,
    });
  });

  it("finalizes a CallRecording (A/V) egress on egress_ended — not a lesson-audio one", async () => {
    // The egressId matches a CallRecording row (room-composite recording), so it
    // completes that row and does NOT fall through to lesson-audio finalize.
    callRecordingFindUnique.mockResolvedValueOnce({
      id: "rec-1",
      bookingId: "booking-9",
      teacherId: "teacher-9",
      endedAt: null,
    });
    receive.mockResolvedValueOnce({
      id: "evt-av",
      event: "egress_ended",
      egressInfo: { egressId: "EG_AV", status: EgressStatus.EGRESS_COMPLETE, fileResults: [] },
    });

    const res = await post({});
    const json = await res.json();
    expect(json).toMatchObject({ code: "call-recording-finalized", failed: false });
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

  it("flags a failed egress so the row is marked failed (no ready event)", async () => {
    receive.mockResolvedValueOnce({
      id: "evt-2",
      event: "egress_ended",
      egressInfo: { egressId: "EG_2", status: EgressStatus.EGRESS_FAILED, fileResults: [] },
    });

    await post({});
    expect(finalizeLessonAudio).toHaveBeenCalledWith(expect.anything(), {
      egressId: "EG_2",
      durationMs: null,
      failed: true,
    });
  });

  it("sweeps dangling captures AND any dangling A/V recording on room_finished for a class room", async () => {
    receive.mockResolvedValueOnce({
      id: "evt-3",
      event: "room_finished",
      room: { name: "class-booking-9" },
    });

    const res = await post({});
    expect(res.status).toBe(200);
    expect(stopLessonAudioCaptures).toHaveBeenCalledWith(expect.anything(), "booking-9");
    expect(finalizeDanglingRecording).toHaveBeenCalledWith(expect.anything(), "booking-9");
  });

  it("ignores room_finished for a non-class room", async () => {
    receive.mockResolvedValueOnce({ id: "evt-4", event: "room_finished", room: { name: "lobby" } });
    await post({});
    expect(stopLessonAudioCaptures).not.toHaveBeenCalled();
    expect(finalizeDanglingRecording).not.toHaveBeenCalled();
  });

  // Regression (2026-08-27): egress webhooks carry NO top-level `room` object —
  // the room lives on `egressInfo.roomName`. parseWebhookEvent read only
  // `raw.room`, so every egress event arrived with `room: null` and the
  // egress_started branch dropped it as "not-a-class-room". Two real recordings
  // were delivered by livekit-server and neither produced call_recording_started.
  it("reads an egress webhook's room from egressInfo.roomName, not raw.room", async () => {
    receive.mockResolvedValueOnce({
      id: "evt-egress-start",
      event: "egress_started",
      // No `room` key at all — this is the shape livekit-server actually sends.
      egressInfo: { egressId: "EG_start", roomName: "class-booking-9" },
    });

    const res = await post({});
    const json = await res.json();
    expect(json).toMatchObject({ code: "call-recording-started-tracked", bookingId: "booking-9" });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_recording_started",
      distinctId: "teacher-9",
      properties: { teacherId: "teacher-9", bookingId: "booking-9" },
    });
  });

  // An empty string, not undefined, is what the protobuf yields for an unset
  // field — so `??` would have kept "" and this must fall through to null.
  it('treats an empty roomName as no room rather than a room named ""', async () => {
    receive.mockResolvedValueOnce({
      id: "evt-egress-noroom",
      event: "egress_started",
      egressInfo: { egressId: "EG_noroom", roomName: "" },
    });

    const res = await post({});
    const json = await res.json();
    expect(json).toMatchObject({ code: "ignored", reason: "not-a-class-room" });
  });

  it("short-circuits a duplicate delivery (webhook_events claim already taken)", async () => {
    webhookEventCreate.mockRejectedValueOnce({ code: "P2002" });
    receive.mockResolvedValueOnce({
      id: "evt-1",
      event: "egress_ended",
      egressInfo: { egressId: "EG_1" },
    });

    const res = await post({});
    const json = await res.json();
    expect(json).toEqual({ ok: true, code: "duplicate-event" });
    expect(finalizeLessonAudio).not.toHaveBeenCalled();
  });

  it("releases the claim and 500s when the handler throws (so the retry reprocesses)", async () => {
    finalizeLessonAudio.mockRejectedValueOnce(new Error("db down"));
    receive.mockResolvedValueOnce({
      id: "evt-5",
      event: "egress_ended",
      egressInfo: { egressId: "EG_5", status: EgressStatus.EGRESS_COMPLETE, fileResults: [] },
    });

    const res = await post({});
    expect(res.status).toBe(500);
    expect(webhookEventDeleteMany).toHaveBeenCalledWith({
      where: { provider: "livekit", eventId: "evt-5" },
    });
  });
});
