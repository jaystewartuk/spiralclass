import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The Gemini adapter, called through Vertex AI (D-127). What matters is that
// every way the provider can say no maps onto a DISTINCT reason, because the
// orchestrator turns those into different messages for the teacher:
// "blocked" tells her to rephrase, while "timeout"/"error" tell her to
// simply retry. Collapsing them into one generic failure is the bug this
// file exists to prevent. The auth token itself is a separate concern —
// see google-vertex-auth.test.ts — mocked here as already-minted.

const env = vi.hoisted(() => ({
  geminiImageModel: vi.fn(() => "gemini-3.1-flash-image"),
  geminiVertexProjectId: vi.fn((): string | undefined => "example-project-00000"),
  geminiVertexLocation: vi.fn(() => "global"),
}));
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const auth = vi.hoisted(() => ({
  getVertexAccessToken: vi.fn(async (): Promise<string | undefined> => "test-token"),
}));
vi.mock("@/lib/ai/google-vertex-auth", () => auth);

// Typed so `fetchSpy.mock.calls[0]` carries the argument tuple — an untyped
// `vi.fn(async () => ...)` infers a zero-arg call signature and every
// assertion on the request would need a cast.
type FetchArgs = [string, RequestInit];
const fetchMock = (impl: (...args: FetchArgs) => Promise<Response>) => vi.fn(impl);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function generate() {
  const { generateWithGemini } = await import("@/lib/ai/gemini-image");
  return generateWithGemini("a funny meme background, no text");
}

beforeEach(() => {
  vi.clearAllMocks();
  env.geminiImageModel.mockReturnValue("gemini-3.1-flash-image");
  env.geminiVertexProjectId.mockReturnValue("example-project-00000");
  env.geminiVertexLocation.mockReturnValue("global");
  auth.getVertexAccessToken.mockResolvedValue("test-token");
});

describe("generateWithGemini", () => {
  it("returns the decoded image bytes on success", async () => {
    const base64 = Buffer.from([1, 2, 3, 4]).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/png", data: base64 } }] } },
          ],
        }),
      ),
    );
    const result = await generate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.bytes)).toEqual([1, 2, 3, 4]);
    expect(result.image.provider).toBe("gemini");
    expect(result.image.model).toBe("gemini-3.1-flash-image");
  });

  it("calls the Vertex AI endpoint (global, this project) with a Bearer token, never an API key in the URL", async () => {
    const base64 = Buffer.from([1]).toString("base64");
    const fetchSpy = fetchMock(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: base64 } }] } }] }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await generate();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/example-project-00000/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(init.headers as Record<string, string>).not.toHaveProperty("X-Goog-Api-Key");
  });

  it("builds a regional (non-global) host when GEMINI_VERTEX_LOCATION overrides it", async () => {
    env.geminiVertexLocation.mockReturnValue("us-central1");
    const base64 = Buffer.from([1]).toString("base64");
    const fetchSpy = fetchMock(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: base64 } }] } }] }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await generate();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/example-project-00000/locations/us-central1/publishers/google/models/gemini-3.1-flash-image:generateContent",
    );
  });

  it("asks for a landscape image", async () => {
    const base64 = Buffer.from([1]).toString("base64");
    const fetchSpy = fetchMock(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: base64 } }] } }] }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await generate();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
  });

  it("reports not-configured rather than calling out with no project id", async () => {
    env.geminiVertexProjectId.mockReturnValue(undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await generate()).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not-configured rather than calling out when the access token can't be minted", async () => {
    auth.getVertexAccessToken.mockResolvedValue(undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await generate()).toEqual({ ok: false, reason: "not-configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("distinguishes a safety refusal from a transport error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("blocked by safety policy", { status: 400 })),
    );
    expect(await generate()).toEqual({ ok: false, reason: "blocked" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );
    expect(await generate()).toEqual({ ok: false, reason: "error" });
  });

  it("treats promptFeedback.blockReason as blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } })),
    );
    expect(await generate()).toEqual({ ok: false, reason: "blocked" });
  });

  it("treats a safety finishReason as blocked, not empty", async () => {
    // A refusal carries no image part AND no promptFeedback — without this
    // branch it would read as an empty response and tell her to retry, which
    // would just burn the same brief again.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }),
      ),
    );
    expect(await generate()).toEqual({ ok: false, reason: "blocked" });
  });

  it("reports empty when the response carries no image part", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: "here you go" }] } }] }),
      ),
    );
    expect(await generate()).toEqual({ ok: false, reason: "empty" });
  });

  it("reports timeout distinctly so the teacher is told to wait, not to rephrase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      }),
    );
    expect(await generate()).toEqual({ ok: false, reason: "timeout" });
  });

  it("reports error for any other transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    expect(await generate()).toEqual({ ok: false, reason: "error" });
  });

  it("reports error on an unparseable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 200 })),
    );
    expect(await generate()).toEqual({ ok: false, reason: "error" });
  });
});
