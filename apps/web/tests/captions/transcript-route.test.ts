import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/captions/transcript — a browser keeping one recognised caption line
// as part of the class's transcript (D-189). The access check is shared with
// the other caption routes and tested in access.test.ts; what this pins is the
// order of this route's own refusals — transcript capture must be on for the
// class, a student's line needs her consent — the rate limits, the append, and
// that only the FIRST kept line of a class arms the completion fallback.

vi.mock("server-only", () => ({}));

const { ApiAuthError } = await import("@/lib/api/auth");

const SESSION = {
  bookingId: "b1",
  role: "teacher",
  teacherIdentity: "t1",
  studentConsent: true,
  transcriptCapture: true,
};
const state = {
  participant: { role: "teacher", teacher: { id: "t1" } } as unknown,
  access: { ok: true, session: { ...SESSION }, callerId: "t1" } as Record<string, unknown>,
  append: { kept: true, started: false },
};
vi.mock("@/lib/api/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/auth")>()),
  requireApiCallParticipant: async () => {
    if (state.participant instanceof Error) throw state.participant;
    return state.participant;
  },
}));
vi.mock("@/lib/captions/access", () => ({ captionAccessFor: async () => state.access }));
const appendBrowserTranscriptLine = vi.fn(async (..._a: unknown[]) => state.append);
vi.mock("@/lib/transcription/browser-transcript", () => ({
  MAX_LINE_DURATION_MS: 60_000,
  appendBrowserTranscriptLine: (...a: unknown[]) => appendBrowserTranscriptLine(...a),
}));
const send = vi.fn(async (..._a: unknown[]) => ({ ids: [] }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }));
vi.mock("@/lib/prisma", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { POST } = await import("@/app/api/captions/transcript/route");
const { __resetBucketsForTests } = await import("@/lib/rate-limit");

const LINE = { bookingId: "b1", speaker: "teacher", text: "Buenos días", durationMs: 1500 };

async function call(body: unknown = LINE, headers: Record<string, string> = {}) {
  const res = await POST(
    new Request("https://test.local/api/captions/transcript", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBucketsForTests();
  state.participant = { role: "teacher", teacher: { id: "t1" } };
  state.access = { ok: true, session: { ...SESSION }, callerId: "t1" };
  state.append = { kept: true, started: false };
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/captions/transcript", () => {
  it("appends the line for the class's teacher and says whether it was kept", async () => {
    expect(await call()).toEqual({ status: 200, body: { ok: true, kept: true } });
    expect(appendBrowserTranscriptLine).toHaveBeenCalledWith(
      { tag: "prisma" },
      {
        bookingId: "b1",
        teacherId: "t1",
        speaker: "teacher",
        text: "Buenos días",
        durationMs: 1500,
      },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("arms the completion fallback on the first kept line of a class only", async () => {
    state.append = { kept: true, started: true };
    await call();
    expect(send).toHaveBeenCalledWith({
      name: "lesson.transcript.capturing",
      data: { bookingId: "b1" },
    });
  });

  it("reports a line the class had already finished as not kept", async () => {
    state.append = { kept: false, started: false };
    expect(await call()).toEqual({ status: 200, body: { ok: true, kept: false } });
  });

  it("refuses when the class's transcript is not being kept", async () => {
    state.access = { ok: true, session: { ...SESSION, transcriptCapture: false }, callerId: "t1" };
    expect(await call()).toMatchObject({ status: 403, body: { reason: "transcript-off" } });
    expect(appendBrowserTranscriptLine).not.toHaveBeenCalled();
  });

  it("refuses a student's line without her captions consent (D-22)", async () => {
    state.access = { ok: true, session: { ...SESSION, studentConsent: false }, callerId: "t1" };
    expect(await call({ ...LINE, speaker: "student" })).toMatchObject({
      status: 403,
      body: { reason: "no-consent" },
    });
    expect(await call()).toMatchObject({ status: 200 });
  });

  it("words each access refusal like the other caption routes", async () => {
    state.access = { ok: false, reason: "not-found" };
    expect((await call()).status).toBe(404);
    state.access = { ok: false, reason: "disabled" };
    expect(await call()).toMatchObject({ status: 403, body: { reason: "captions-off" } });
    state.access = { ok: false, reason: "not-entitled" };
    expect(await call()).toMatchObject({ status: 403, body: { reason: "not-entitled" } });
    expect(appendBrowserTranscriptLine).not.toHaveBeenCalled();
  });

  it("rate-limits by characters per caller per minute", async () => {
    const long = { ...LINE, text: "x".repeat(500) };
    for (let i = 0; i < 6; i++) expect((await call(long)).status).toBe(200);
    expect(await call(long)).toMatchObject({ status: 429, body: { reason: "rate-limited" } });
    expect(appendBrowserTranscriptLine).toHaveBeenCalledTimes(6);
  });

  it("refuses a malformed body: an empty line, an over-long one, or an impossible duration", async () => {
    expect((await call({ ...LINE, text: "" })).status).toBe(400);
    expect((await call({ ...LINE, text: "x".repeat(501) })).status).toBe(400);
    expect((await call({ ...LINE, durationMs: 60_001 })).status).toBe(400);
    expect((await call({ ...LINE, durationMs: 1.5 })).status).toBe(400);
    expect(appendBrowserTranscriptLine).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before reading the body", async () => {
    state.participant = new ApiAuthError(401, "no-session");
    expect((await call({ nonsense: true })).status).toBe(401);
  });

  it("refuses a cross-origin request", async () => {
    expect((await call(LINE, { origin: "https://evil.example" })).status).toBe(403);
    expect(appendBrowserTranscriptLine).not.toHaveBeenCalled();
  });
});
