import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/captions/translate — the server half of live-caption translation
// (D-185), and the only caption surface that spends money. Everything between
// the session and Google is REAL here — the flag/key gate, the access check,
// the consent check, the rate limiter and the Google client — with only the
// session, the database and the network faked, so each refusal is asserted
// through the same path production takes.

vi.mock("server-only", () => ({}));

// Hoisted: importing the auth module below pulls in the logger, whose mock
// factory reads these.
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
  role: "teacher",
  teacherIdentity: "t1",
  directions: {
    teacher: { source: "es", target: "en" },
    student: { source: "en", target: "es" },
  },
  recognitionLocales: { teacher: "es-MX", student: "en" },
  studentConsent: true,
};
const db = { session: SESSION as typeof SESSION | null, gateOk: true };
vi.mock("@/lib/captions/class-access", () => ({
  resolveCaptionSession: async () => db.session,
}));
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: async () => ["s1"] }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: async () => (db.gateOk ? { ok: true } : { ok: false, limit: "lesson_notes" }),
}));

vi.mock("@/lib/logger", () => ({
  logger: () => ({ info, warn, error: vi.fn(), debug: vi.fn() }),
}));

const { POST } = await import("@/app/api/captions/translate/route");
const { __resetBucketsForTests } = await import("@/lib/rate-limit");

const google = vi.fn();

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://test.local/api/captions/translate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const BODY = { bookingId: "b1", speaker: "teacher", text: "¿Cómo estás?" };

// A fresh Response per call: a body can only be read once.
function googleSays(text: string, status = 200) {
  google.mockImplementation(async () =>
    status === 200
      ? new Response(JSON.stringify({ data: { translations: [{ translatedText: text }] } }), {
          status,
        })
      : new Response("error", { status }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBucketsForTests();
  vi.stubEnv("LIVE_CAPTIONS_ENABLED", "1");
  vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "AIza-key");
  vi.stubGlobal("fetch", google);
  auth.participant = { role: "teacher", teacher: { id: "t1" } };
  db.session = { ...SESSION };
  db.gateOk = true;
  googleSays("How are you?");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function call(body: unknown = BODY, headers?: Record<string, string>) {
  const res = await POST(req(body, headers));
  return { status: res.status, body: await res.json() };
}

describe("POST /api/captions/translate — happy path", () => {
  it("translates the teacher's utterance through Google", async () => {
    expect(await call()).toEqual({ status: 200, body: { ok: true, text: "How are you?" } });
    expect(google).toHaveBeenCalledTimes(1);
  });

  it("lets the student translate her own speech when she has consented", async () => {
    auth.participant = { role: "student", student: { id: "s1", email: "a@b.c" } };
    googleSays("¿Cómo estás?");
    const { status } = await call({ ...BODY, speaker: "student", text: "How are you?" });
    expect(status).toBe(200);
    const sent = JSON.parse(String(google.mock.calls[0][1].body));
    expect(sent).toMatchObject({ source: "en", target: "es" });
  });

  // The server, not the client, decides the pair. A client that could name
  // languages could use this route as a general translation service billed
  // to the platform.
  it("uses the booking's direction and ignores any languages the client sends", async () => {
    await call({ ...BODY, source: "ja", target: "de", from: "ja", to: "de" });
    const sent = JSON.parse(String(google.mock.calls[0][1].body));
    expect(sent).toEqual({ q: "¿Cómo estás?", source: "es", target: "en", format: "text" });
  });

  it("skips Google, and the cost, when both sides share a language", async () => {
    db.session = {
      ...SESSION,
      directions: { ...SESSION.directions, teacher: { source: "es-MX", target: "es" } },
    };
    expect(await call()).toEqual({ status: 200, body: { ok: true, text: "¿Cómo estás?" } });
    expect(google).not.toHaveBeenCalled();
  });

  it("logs the character count and never the text", async () => {
    await call();
    expect(info).toHaveBeenCalledWith("caption translated", {
      bookingId: "b1",
      speaker: "teacher",
      chars: BODY.text.length,
      ok: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("Cómo");
  });
});

describe("POST /api/captions/translate — refusals", () => {
  it("refuses a cross-origin request before anything else", async () => {
    expect((await call(BODY, { origin: "https://evil.example" })).status).toBe(403);
    expect(google).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller with 401", async () => {
    auth.participant = new ApiAuthError(401, "no-session");
    expect(await call()).toMatchObject({ status: 401, body: { reason: "no-session" } });
  });

  it("refuses a signed-in user who is neither teacher nor student with 403", async () => {
    auth.participant = new ApiAuthError(403, "no-participant-row");
    expect((await call()).status).toBe(403);
  });

  it("refuses a caller who is not a party to this class with 404", async () => {
    db.session = null;
    expect(await call()).toMatchObject({ status: 404, body: { reason: "not-found" } });
    expect(google).not.toHaveBeenCalled();
  });

  it("refuses when the feature flag is off", async () => {
    vi.stubEnv("LIVE_CAPTIONS_ENABLED", "");
    expect(await call()).toMatchObject({ status: 403, body: { reason: "captions-off" } });
    expect(google).not.toHaveBeenCalled();
  });

  it("refuses when the Google key is missing, even with the flag on", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");
    expect(await call()).toMatchObject({ status: 403, body: { reason: "captions-off" } });
    expect(google).not.toHaveBeenCalled();
  });

  it("refuses when the teacher's plan does not include captions", async () => {
    db.gateOk = false;
    expect(await call()).toMatchObject({ status: 403, body: { reason: "not-entitled" } });
  });

  // D-22, enforced here as well as in the browser: whichever participant
  // recognised her speech, it is not translated without her consent.
  it("refuses the student's speech without consent, whoever sends it", async () => {
    db.session = { ...SESSION, studentConsent: false };
    const asTeacher = await call({ ...BODY, speaker: "student" });
    expect(asTeacher).toMatchObject({ status: 403, body: { reason: "no-consent" } });

    auth.participant = { role: "student", student: { id: "s1", email: "a@b.c" } };
    const asStudent = await call({ ...BODY, speaker: "student" });
    expect(asStudent.status).toBe(403);
    expect(google).not.toHaveBeenCalled();
  });

  it("still translates the teacher's speech when the student has not consented", async () => {
    db.session = { ...SESSION, studentConsent: false };
    expect((await call()).status).toBe(200);
  });

  it("refuses text over the cap, and empty text", async () => {
    expect((await call({ ...BODY, text: "a".repeat(501) })).status).toBe(400);
    expect((await call({ ...BODY, text: "   " })).status).toBe(400);
    expect(google).not.toHaveBeenCalled();
  });

  it("refuses an unknown speaker role", async () => {
    expect((await call({ ...BODY, speaker: "admin" })).status).toBe(400);
  });

  it("rate-limits a caller by characters per minute", async () => {
    const text = "a".repeat(500);
    for (let i = 0; i < 6; i++) expect((await call({ ...BODY, text })).status).toBe(200);
    const limited = await call({ ...BODY, text });
    expect(limited).toMatchObject({ status: 429, body: { reason: "rate-limited" } });
    expect(limited.body.retryAfterMs).toBeGreaterThan(0);
    expect(google).toHaveBeenCalledTimes(6);
  });

  it("maps a Google 4xx to one clean error", async () => {
    googleSays("", 400);
    expect(await call()).toMatchObject({ status: 502, body: { reason: "translate-failed" } });
    expect(info).toHaveBeenCalledWith(
      "caption translated",
      expect.objectContaining({ ok: false, reason: "rejected", status: 400 }),
    );
  });

  it("maps a Google 5xx to the same clean error", async () => {
    googleSays("", 503);
    expect(await call()).toMatchObject({ status: 502, body: { reason: "translate-failed" } });
  });
});
