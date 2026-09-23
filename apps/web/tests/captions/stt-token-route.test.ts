import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/captions/stt-token — the route that lets a phone stream its own
// speech to Deepgram when no browser in the class can recognise it (D-185's
// addendum), and so the one that spends Deepgram minutes. Everything between
// the session and Deepgram is REAL here — the flag/key gate, the access and
// consent checks, the warranted-room check, the rate limiter and the grant
// client — with only the session, the database, LiveKit and the network
// faked, so each refusal is asserted through the path production takes.

vi.mock("server-only", () => ({}));

const { info, warn } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

const { ApiAuthError } = await import("@/lib/api/auth");

type Participant =
  | { role: "teacher"; teacher: { id: string } }
  | { role: "student"; student: { id: string; email: string } };
const auth = { participant: { role: "teacher", teacher: { id: "t1" } } as Participant | Error };
vi.mock("@/lib/api/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/auth")>()),
  requireApiCallParticipant: async () => {
    if (auth.participant instanceof Error) throw auth.participant;
    return auth.participant;
  },
}));

const SESSION = {
  bookingId: "b1",
  role: "teacher" as "teacher" | "student",
  teacherIdentity: "t1",
  directions: {
    teacher: { source: "es", target: "en" },
    student: { source: "en", target: "es" },
  },
  recognitionLocales: { teacher: "es-MX", student: "en" },
  studentConsent: true,
  cloudRecognition: true,
};
const db = { session: SESSION as typeof SESSION | null, gateOk: true };
vi.mock("@/lib/captions/class-access", () => ({
  resolveCaptionSession: async () => db.session,
}));
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: async () => ["s1"] }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: async () => (db.gateOk ? { ok: true } : { ok: false, limit: "lesson_notes" }),
}));

type Attrs = { identity: string; attributes: Record<string, string> };
const phoneRoom = (): Attrs[] => [
  { identity: "t1", attributes: { captionsOn: "true", captionsAsr: "0" } },
  { identity: "s1", attributes: { captionsAsr: "0" } },
];
const livekit = { room: phoneRoom() as Attrs[] | null | Error };
const listRoom = vi.fn(async (_room: string) => {
  if (livekit.room instanceof Error) throw livekit.room;
  return livekit.room;
});
vi.mock("@/lib/video/room", () => ({
  listRoomParticipantAttributes: (room: string) => listRoom(room),
}));

vi.mock("@/lib/logger", () => ({
  logger: () => ({ info, warn, error: vi.fn(), debug: vi.fn() }),
}));

const { POST } = await import("@/app/api/captions/stt-token/route");
const { __resetBucketsForTests } = await import("@/lib/rate-limit");

const deepgram = vi.fn();

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://test.local/api/captions/stt-token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const BODY = { bookingId: "b1" };

function deepgramSays(status: number, body: unknown = { access_token: "jwt", expires_in: 30 }) {
  deepgram.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBucketsForTests();
  vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
  vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
  vi.stubEnv("DEEPGRAM_API_KEY", "dg-key");
  vi.stubGlobal("fetch", deepgram);
  auth.participant = { role: "teacher", teacher: { id: "t1" } };
  db.session = { ...SESSION };
  db.gateOk = true;
  livekit.room = phoneRoom();
  deepgramSays(200);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function call(body: unknown = BODY, headers?: Record<string, string>) {
  const res = await POST(req(body, headers));
  return { status: res.status, body: await res.json() };
}

const asStudent = () => {
  auth.participant = { role: "student", student: { id: "s1", email: "a@b.c" } };
  db.session = { ...SESSION, role: "student" };
};

describe("POST /api/captions/stt-token — happy path", () => {
  it("grants the teacher a token and a listen URL in her own language", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, token: "jwt", expiresInSeconds: 30 });
    const url = new URL(body.url);
    expect(url.host).toBe("api.deepgram.com");
    expect(url.searchParams.get("language")).toBe("es-419");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(listRoom).toHaveBeenCalledWith("class-b1");
    expect(deepgram).toHaveBeenCalledTimes(1);
  });

  it("grants a consenting student a token for her own speech, in her language", async () => {
    asStudent();
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(new URL(body.url).searchParams.get("language")).toBe("en");
  });

  // The server, not the client, decides the language: a client that could
  // name one could stream anything it liked on the platform's account.
  it("ignores any language or model the client sends", async () => {
    const { body } = await call({ ...BODY, language: "ja", model: "whisper", speaker: "student" });
    const url = new URL(body.url);
    expect(url.searchParams.get("language")).toBe("es-419");
    expect(url.searchParams.get("model")).toBe("nova-3");
  });

  it("logs the grant and never the token", async () => {
    await call();
    expect(info).toHaveBeenCalledWith("caption stt token granted", {
      bookingId: "b1",
      speaker: "teacher",
      language: "es-419",
      ok: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("jwt");
  });
});

describe("POST /api/captions/stt-token — refusals", () => {
  it("refuses a cross-origin request before anything else", async () => {
    expect((await call(BODY, { origin: "https://evil.example" })).status).toBe(403);
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller with 401", async () => {
    auth.participant = new ApiAuthError(401, "no-session");
    expect(await call()).toMatchObject({ status: 401, body: { reason: "no-session" } });
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not a party to this class with 404", async () => {
    db.session = null;
    expect(await call()).toMatchObject({ status: 404, body: { reason: "not-found" } });
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("refuses when the captions flag is off", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "");
    expect(await call()).toMatchObject({ status: 403, body: { reason: "captions-off" } });
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("refuses when the Deepgram key is missing", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(await call()).toMatchObject({ status: 403, body: { reason: "cloud-off" } });
    expect(listRoom).not.toHaveBeenCalled();
  });

  it("refuses when the teacher's plan does not include captions", async () => {
    db.gateOk = false;
    expect(await call()).toMatchObject({ status: 403, body: { reason: "not-entitled" } });
    expect(deepgram).not.toHaveBeenCalled();
  });

  // D-22: her speech never leaves her device for Deepgram without consent.
  it("refuses a student who has not consented", async () => {
    asStudent();
    db.session = { ...SESSION, role: "student", studentConsent: false };
    expect(await call()).toMatchObject({ status: 403, body: { reason: "no-consent" } });
    expect(listRoom).not.toHaveBeenCalled();
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("still grants the teacher when the student has not consented", async () => {
    db.session = { ...SESSION, studentConsent: false };
    expect((await call()).status).toBe(200);
  });

  it("refuses a language Nova-3 cannot stream", async () => {
    db.session = { ...SESSION, recognitionLocales: { teacher: "sw", student: "en" } };
    expect(await call()).toMatchObject({ status: 422, body: { reason: "unsupported-language" } });
    expect(deepgram).not.toHaveBeenCalled();
  });

  // The cost boundary: a room where any browser can recognise is captioned
  // for free, so it never gets a paid stream.
  it("refuses when a browser in the room can recognise", async () => {
    livekit.room = [
      { identity: "t1", attributes: { captionsOn: "true", captionsAsr: "1" } },
      { identity: "s1", attributes: { captionsAsr: "0" } },
    ];
    expect(await call()).toMatchObject({
      status: 409,
      body: { reason: "not-warranted", refusal: "browser-can-recognise" },
    });
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("refuses while the teacher's switch is off, or the caller is alone or absent", async () => {
    livekit.room = [
      { identity: "t1", attributes: { captionsOn: "false" } },
      { identity: "s1", attributes: {} },
    ];
    expect((await call()).body).toMatchObject({ refusal: "captions-off" });
    livekit.room = [{ identity: "t1", attributes: { captionsOn: "true" } }];
    expect((await call()).body).toMatchObject({ refusal: "alone" });
    livekit.room = [{ identity: "s1", attributes: {} }];
    expect((await call()).body).toMatchObject({ refusal: "caller-absent" });
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("refuses rather than guesses when LiveKit cannot be read", async () => {
    livekit.room = new Error("twirp");
    expect(await call()).toMatchObject({ status: 503, body: { reason: "room-unavailable" } });
    livekit.room = null;
    expect(await call()).toMatchObject({ status: 503, body: { reason: "room-unavailable" } });
    expect(deepgram).not.toHaveBeenCalled();
  });

  it("rate-limits grants per caller per class", async () => {
    for (let i = 0; i < 30; i++) expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited).toMatchObject({ status: 429, body: { reason: "rate-limited" } });
    expect(limited.body.retryAfterMs).toBeGreaterThan(0);
    expect(deepgram).toHaveBeenCalledTimes(30);
    // The other participant has their own allowance.
    asStudent();
    expect((await call()).status).toBe(200);
  });

  it("maps a Deepgram 4xx to one clean error, logging why", async () => {
    deepgramSays(403, { err_code: "FORBIDDEN" });
    expect(await call()).toMatchObject({ status: 502, body: { reason: "grant-failed" } });
    expect(info).toHaveBeenCalledWith(
      "caption stt token granted",
      expect.objectContaining({ ok: false, reason: "rejected", status: 403 }),
    );
  });

  it("maps a Deepgram 5xx to the same clean error", async () => {
    deepgramSays(503, {});
    expect(await call()).toMatchObject({ status: 502, body: { reason: "grant-failed" } });
  });
});
