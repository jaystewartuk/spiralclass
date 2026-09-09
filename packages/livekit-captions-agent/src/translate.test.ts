import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config";

// Mock the Anthropic SDK so translateCaption is testable without a key or a
// network call. The lazy client constructs `new Anthropic(...)` on first use,
// so the default export is a class whose instances expose `messages.create`.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const logEvent = vi.fn();
vi.mock("./log", () => ({ logEvent }));

const { buildCaptionTranslationPrompt, extractTranslation, translateCaption } =
  await import("./translate");

const CONFIG: Pick<AgentConfig, "anthropicApiKey" | "anthropicModel" | "captionTranslationModel"> =
  {
    anthropicApiKey: "key",
    anthropicModel: "claude-opus-test",
    captionTranslationModel: "claude-haiku-test",
  };
const DIRECTION = { source: "es", target: "en" };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildCaptionTranslationPrompt", () => {
  it("describes the source→target subtitle task and the output-only rule", () => {
    const prompt = buildCaptionTranslationPrompt(DIRECTION);
    expect(prompt).toContain("Spanish");
    expect(prompt).toContain("English");
    expect(prompt.toLowerCase()).toContain("only");
  });
});

describe("extractTranslation", () => {
  it("joins text blocks and trims, ignoring non-text blocks", () => {
    const content = [
      { type: "text", text: "How " },
      { type: "thinking", thinking: "noise" },
      { type: "text", text: "are you? " },
    ] as unknown as Parameters<typeof extractTranslation>[0];
    expect(extractTranslation(content)).toBe("How are you?");
  });

  it("returns empty string when there is no text block", () => {
    const content = [{ type: "tool_use", id: "x", name: "y", input: {} }] as unknown as Parameters<
      typeof extractTranslation
    >[0];
    expect(extractTranslation(content)).toBe("");
  });
});

describe("translateCaption", () => {
  it("returns null for blank/whitespace input without calling out", async () => {
    const res = await translateCaption(CONFIG, "   ", DIRECTION);
    expect(res).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("translates a finished utterance via the configured caption model", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "How are you?" }] });
    const res = await translateCaption(CONFIG, "¿Cómo estás?", DIRECTION);
    expect(res).toBe("How are you?");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-test",
        messages: [{ role: "user", content: "¿Cómo estás?" }],
      }),
    );
  });

  it("does not send output_config.effort (rejected with a 400 on Haiku 4.5)", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "How are you?" }] });
    await translateCaption(CONFIG, "¿Cómo estás?", DIRECTION);
    const params = create.mock.calls[0]?.[0] ?? {};
    expect(params).not.toHaveProperty("output_config");
  });

  it("returns null when the model yields no text", async () => {
    create.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] });
    const res = await translateCaption(CONFIG, "¿Cómo estás?", DIRECTION);
    expect(res).toBeNull();
  });

  it("returns null when the model call throws", async () => {
    create.mockRejectedValue(new Error("anthropic down"));
    const res = await translateCaption(CONFIG, "¿Cómo estás?", DIRECTION);
    expect(res).toBeNull();
  });
});

// Mirrors apps/web/src/lib/captions/translate.ts's fallback-latch behavior:
// if the caption model (Haiku) isn't accessible on this key, fall back to
// the main model and latch so later lines skip the doomed primary call.
// Each test re-imports the module fresh (resetModules) because the
// "unusable" latch is process-global by design.
describe("caption-model fallback (no-access → main model)", () => {
  async function freshTranslate() {
    vi.resetModules();
    const mod = await import("./translate");
    return mod.translateCaption;
  }
  const accessError = (status: number) => Object.assign(new Error("no access"), { status });

  it("falls back to the main model when the caption model is rejected with 404", async () => {
    const translate = await freshTranslate();
    create
      .mockRejectedValueOnce(accessError(404))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "How are you?" }] });

    const res = await translate(CONFIG, "¿Cómo estás?", DIRECTION);

    expect(res).toBe("How are you?");
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: "claude-haiku-test" }),
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: "claude-opus-test" }),
    );
  });

  it("also falls back on a 403 (model explicitly disabled for the account)", async () => {
    const translate = await freshTranslate();
    create
      .mockRejectedValueOnce(accessError(403))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Hello" }] });

    expect(await translate(CONFIG, "Hola", DIRECTION)).toBe("Hello");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("latches: after one access failure, later lines call the main model directly", async () => {
    const translate = await freshTranslate();
    create
      .mockRejectedValueOnce(accessError(404))
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await translate(CONFIG, "uno", DIRECTION); // trips the latch: haiku (fail) -> opus (ok) = 2 calls
    create.mockClear();

    const res = await translate(CONFIG, "dos", DIRECTION);
    expect(res).toBe("ok");
    expect(create).toHaveBeenCalledTimes(1); // straight to the main model, no wasted call
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-test" }));
  });

  it("does NOT fall back on a transient 429 — that one line drops, model unchanged", async () => {
    const translate = await freshTranslate();
    create.mockRejectedValue(accessError(429));

    const res = await translate(CONFIG, "¿Cómo estás?", DIRECTION);
    expect(res).toBeNull();
    expect(create).toHaveBeenCalledTimes(1); // no fallback attempt
  });

  it("returns null (line dropped) when BOTH the caption and fallback models fail", async () => {
    const translate = await freshTranslate();
    create.mockRejectedValueOnce(accessError(404)).mockRejectedValueOnce(accessError(404));

    expect(await translate(CONFIG, "¿Cómo estás?", DIRECTION)).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
