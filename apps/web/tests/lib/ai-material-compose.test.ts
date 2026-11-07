import { beforeEach, describe, expect, it, vi } from "vitest";

// A teacher reported that AI edits which made a material bigger came back cut
// off. The API answers such a call with HTTP 200 and stop_reason "max_tokens",
// and the text it carries looks like a draft, so these pin that a document is
// only ever returned whole, and that the budget can hold a whole one.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  anthropicApiKey: () => "k",
  anthropicModel: () => "claude-sonnet-5",
  hasAnthropicCreds: () => true,
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock("@/lib/materials/prompt", () => ({
  buildMaterialPrompt: () => ({ system: "s", user: "u" }),
  buildMaterialRefinePrompt: () => ({ system: "s", user: "u" }),
}));
vi.mock("@/lib/materials/podcast-prompt", () => ({
  buildPodcastScriptPrompt: () => ({ system: "s", user: "u" }),
}));
vi.mock("@/lib/homework/ai-review-prompt", () => ({}));

type Final = { content: unknown[]; stop_reason: string };
let final: Final;
let events: unknown[];
const stream = vi.fn((_params: { max_tokens: number }) => ({
  finalMessage: async () => final,
  async *[Symbol.asyncIterator]() {
    yield* events;
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream };
  },
}));

const { generateMaterial, generateMaterialStream, generatePodcastScript, refineMaterial } =
  await import("@/lib/ai/anthropic");
const { CLASS_CONTENT_MAX_CHARS, MATERIAL_MAX_OUTPUT_TOKENS, MaterialIncompleteError } =
  await import("@/lib/materials/config");

const reply = (text: string, stop_reason: string): Final => ({
  content: [{ type: "text", text }],
  stop_reason,
});
const refineInput = { currentBody: "# Hi", instruction: "add exercises" } as never;
const generateInput = {} as never;

beforeEach(() => {
  stream.mockClear();
  events = [];
});

describe.each([
  ["refineMaterial", () => refineMaterial(refineInput)],
  ["generateMaterial", () => generateMaterial(generateInput)],
])("%s", (_name, call) => {
  it("returns a finished document", async () => {
    final = reply("# Whole", "end_turn");
    expect(await call()).toEqual({ ok: true, body: "# Whole" });
  });

  it("refuses a document the model ran out of tokens on", async () => {
    final = reply("# The front half of a document", "max_tokens");
    expect(await call()).toEqual({ ok: false, reason: "truncated" });
  });

  it("refuses an over-long document rather than cutting it to the ceiling", async () => {
    final = reply("x".repeat(CLASS_CONTENT_MAX_CHARS + 1), "end_turn");
    expect(await call()).toEqual({ ok: false, reason: "truncated" });
  });

  it("does not offer text from a refusal as a draft", async () => {
    final = reply("# Started, then declined", "refusal");
    expect(await call()).toEqual({ ok: false, reason: "error" });
  });

  it("asks for enough room to hold a full document after thinking", async () => {
    final = reply("# Whole", "end_turn");
    await call();
    expect(stream.mock.calls[0]![0].max_tokens).toBe(MATERIAL_MAX_OUTPUT_TOKENS);
    // Four characters a token is a fair rate for Spanish; the rest is for
    // thinking and for scripts that spend more tokens per character.
    expect(MATERIAL_MAX_OUTPUT_TOKENS).toBeGreaterThan(CLASS_CONTENT_MAX_CHARS / 4 + 8_000);
  });
});

describe("generatePodcastScript", () => {
  it("fails rather than narrating a script that stops mid-sentence", async () => {
    final = reply("Hola y bienvenidos a", "max_tokens");
    expect(await generatePodcastScript({} as never)).toEqual({ ok: false, reason: "truncated" });
  });
});

describe("generateMaterialStream", () => {
  const text = (t: string) => ({
    type: "content_block_delta",
    delta: { type: "text_delta", text: t },
  });
  const drain = async () => {
    const out: string[] = [];
    for await (const d of generateMaterialStream(generateInput)) out.push(d);
    return out;
  };

  it("yields the text of a finished document", async () => {
    events = [text("# Ho"), text("la")];
    final = reply("# Hola", "end_turn");
    expect(await drain()).toEqual(["# Ho", "la"]);
  });

  it("throws the incomplete error when the model ran out of tokens", async () => {
    events = [text("# Ho")];
    final = reply("# Ho", "max_tokens");
    await expect(drain()).rejects.toBeInstanceOf(MaterialIncompleteError);
  });
});
