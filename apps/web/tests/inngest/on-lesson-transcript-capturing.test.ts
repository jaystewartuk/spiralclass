import { beforeEach, describe, expect, it, vi } from "vitest";

// The completion fallback for a browser-written transcript (D-189): waits until
// the class is surely over, then finalises — so a transcript never sits "live"
// for ever if the room_finished webhook goes missing (#108 again).

vi.mock("@/lib/inngest/client", () => ({
  inngest: { createFunction: () => ({}), send: vi.fn() },
}));
const bookingFindUnique = vi.fn(async (..._a: unknown[]) => ({
  scheduledEnd: new Date("2026-10-01T15:00:00Z"),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: (...a: unknown[]) => bookingFindUnique(...a) } },
}));
const finalizeBrowserTranscript = vi.fn(async (..._a: unknown[]) => ({
  code: "finalized",
  utteranceCount: 4,
}));
vi.mock("@/lib/transcription/browser-transcript", () => ({
  finalizeBrowserTranscript: (...a: unknown[]) => finalizeBrowserTranscript(...a),
}));

const { CAPTURE_GRACE_MS, CAPTURE_MIN_WAIT_MS, finalizeAt, onLessonTranscriptCapturingHandler } =
  await import("@/lib/inngest/functions/on-lesson-transcript-capturing");

// Inngest serialises each step's result as JSON, so the fake does the same:
// a Date returned from a step comes back as a string, which is why the handler
// returns an ISO string rather than a Date.
const slept: { id: string; until: Date }[] = [];
const step = {
  run: async <T>(_id: string, fn: () => T | Promise<T>) =>
    JSON.parse(JSON.stringify(await fn())) as T,
  sleepUntil: async (id: string, until: Date) => {
    slept.push({ id, until });
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  slept.length = 0;
  vi.useRealTimers();
});

describe("finalizeAt", () => {
  const now = Date.parse("2026-10-01T14:30:00Z");

  it("waits for the scheduled end plus the grace for a class that runs long", () => {
    expect(finalizeAt(new Date("2026-10-01T15:00:00Z"), now)).toEqual(
      new Date(Date.parse("2026-10-01T15:00:00Z") + CAPTURE_GRACE_MS),
    );
  });

  it("never fires sooner than the minimum wait, for a class that started after its slot", () => {
    expect(finalizeAt(new Date("2026-10-01T13:00:00Z"), now)).toEqual(
      new Date(now + CAPTURE_MIN_WAIT_MS),
    );
    expect(finalizeAt(null, now)).toEqual(new Date(now + CAPTURE_MIN_WAIT_MS));
  });
});

describe("onLessonTranscriptCapturingHandler", () => {
  it("sleeps until the class is over, then finalises the transcript", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-01T14:30:00Z") });
    const res = await onLessonTranscriptCapturingHandler({
      event: { data: { bookingId: "b1" } },
      step,
    });
    expect(bookingFindUnique).toHaveBeenCalledWith({
      where: { id: "b1" },
      select: { scheduledEnd: true },
    });
    expect(slept).toEqual([
      {
        id: "class-over",
        until: new Date(Date.parse("2026-10-01T15:00:00Z") + CAPTURE_GRACE_MS),
      },
    ]);
    expect(finalizeBrowserTranscript).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "b1",
    );
    expect(res).toEqual({ code: "finalized", utteranceCount: 4 });
  });

  it("still finalises a booking that has since disappeared, after the minimum wait", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-01T14:30:00Z") });
    bookingFindUnique.mockResolvedValueOnce(null as never);
    await onLessonTranscriptCapturingHandler({ event: { data: { bookingId: "b1" } }, step });
    expect(slept[0].until).toEqual(
      new Date(Date.parse("2026-10-01T14:30:00Z") + CAPTURE_MIN_WAIT_MS),
    );
    expect(finalizeBrowserTranscript).toHaveBeenCalledTimes(1);
  });
});
