import { describe, it, expect, vi, beforeEach } from "vitest";

// The live "watch it write" material-generation route. This pins two things:
//  1. Deltas from the model are streamed through verbatim, then the DONE
//     sentinel (U+001F) is appended once on success.
//  2. The response carries the anti-buffering headers. These are load-bearing:
//     since the app moved off Vercel to self-hosted Docker on Fly (D-70),
//     Next's own compression buffers a chunked text/plain body unless the
//     response opts out via `no-transform`, which silently reverted the
//     streaming UI back to a plain loading spinner. `x-accel-buffering: no`
//     covers a proxy doing the same one layer out. Guard both so the fix can't
//     regress unnoticed — nothing else in the suite exercises this route's
//     streaming contract end to end.

const prepareLibraryMaterialPrompt = vi.fn();
const recordLibraryMaterialGeneration = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/materials/handlers", () => ({
  prepareLibraryMaterialPrompt: (i: unknown) => prepareLibraryMaterialPrompt(i),
  recordLibraryMaterialGeneration: (...a: unknown[]) => recordLibraryMaterialGeneration(...a),
}));

const generateMaterialStream = vi.fn();
vi.mock("@/lib/ai/anthropic", () => ({
  generateMaterialStream: (i: unknown) => generateMaterialStream(i),
}));

vi.mock("@/lib/env", () => ({ hasAnthropicCreds: vi.fn(() => true) }));

vi.mock("@/lib/api/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api/auth")>();
  return {
    ...actual,
    requireApiOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const { POST } = await import("@/app/api/materials/generate/stream/route");

const DONE = "\u001F";

function req(body: unknown): Request {
  return new Request("http://test.local/api/materials/generate/stream", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function* deltas(...chunks: string[]) {
  for (const c of chunks) yield c;
}

async function drainRaw(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
  }
  return acc;
}

// Decode the SSE wire format the same way the web/mobile clients do: split on
// the blank-line frame delimiter, JSON-parse each `data:` payload. Returns the
// concatenated deltas and whether the DONE sentinel frame arrived.
async function drainSse(res: Response): Promise<{ body: string; done: boolean }> {
  const raw = await drainRaw(res);
  let body = "";
  let done = false;
  for (const f of raw.split("\n\n")) {
    const line = f.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const text = JSON.parse(line.slice(line.indexOf(":") + 1).trimStart()) as string;
    if (text === DONE) done = true;
    else body += text;
  }
  return { body, done };
}

beforeEach(() => {
  prepareLibraryMaterialPrompt.mockReset();
  recordLibraryMaterialGeneration.mockClear();
  generateMaterialStream.mockReset();
  prepareLibraryMaterialPrompt.mockResolvedValue({
    ok: true,
    promptInput: {},
    meta: {},
  });
});

describe("POST materials/generate/stream", () => {
  it("streams the model deltas as SSE frames, then a DONE sentinel frame", async () => {
    generateMaterialStream.mockReturnValue(deltas("# Hola", " mundo"));
    const res = await POST(req({ topic: "greetings" }));
    expect(res.status).toBe(200);
    const { body, done } = await drainSse(res);
    expect(body).toBe("# Hola mundo");
    expect(done).toBe(true);
    expect(recordLibraryMaterialGeneration).toHaveBeenCalledTimes(1);
  });

  it("keeps markdown newlines intact across frame boundaries", async () => {
    // JSON-encoding each delta keeps it single-line, so a chunk full of
    // newlines can't be mistaken for the blank-line frame delimiter.
    generateMaterialStream.mockReturnValue(deltas("# Title\n\n- a\n- b", "\n\nDone"));
    const { body, done } = await drainSse(await POST(req({ topic: "x" })));
    expect(body).toBe("# Title\n\n- a\n- b\n\nDone");
    expect(done).toBe(true);
  });

  it("serves SSE with the anti-buffering headers so nothing buffers the stream", async () => {
    generateMaterialStream.mockReturnValue(deltas("x"));
    const res = await POST(req({ topic: "x" }));
    // text/event-stream is the content type the Cloudflare/Fly/Next chain
    // streams unbuffered; the other two headers cover nginx-family proxies.
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("closes without the DONE frame and burns no quota when generation throws mid-stream", async () => {
    async function* boom() {
      yield "partial";
      throw new Error("provider blew up");
    }
    generateMaterialStream.mockReturnValue(boom());
    const { body, done } = await drainSse(await POST(req({ topic: "x" })));
    expect(body).toBe("partial");
    expect(done).toBe(false);
    expect(recordLibraryMaterialGeneration).not.toHaveBeenCalled();
  });

  it("maps a gate failure to its status before streaming starts", async () => {
    prepareLibraryMaterialPrompt.mockResolvedValue({
      ok: false,
      code: "not-pro",
      message: "Upgrade to Pro",
    });
    const res = await POST(req({ topic: "x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: "not-pro" });
    expect(generateMaterialStream).not.toHaveBeenCalled();
  });
});
