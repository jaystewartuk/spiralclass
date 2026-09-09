import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The generation call itself. Ordering is the thing under test: every cheap
// refusal must happen before a paid provider call, and a malformed response
// must become an actionable reason rather than a half-written post.

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const hasAnthropicCreds = vi.fn(() => true);
vi.mock("@/lib/env", () => ({
  hasAnthropicCreds,
  anthropicApiKey: () => "sk-test",
  anthropicModel: () => "claude-test",
}));

const rateLimit = vi.fn(async () => ({ ok: true }) as { ok: boolean; retryAfterMs?: number });
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));

const { generateMarketingContent, MARKETING_CONTENT_TOOL } =
  await import("@/lib/marketing/content");

const CONTEXT = {
  teacherId: "t1",
  teacherName: "Mira",
  bookingSlug: "mira",
  subject: "Spanish",
  teachingLanguage: "Spanish",
  locale: "es-MX",
  country: "MX",
  headline: null,
  bio: null,
  testimonials: [],
  packages: [],
  availableWeekdays: [],
  activeStudentCount: 0,
  profile: {
    audiences: [],
    learnerLocations: [],
    levels: [],
    differentiator: null,
    weeklyMinutes: 60,
    goalNewStudentsPerMonth: 2,
  },
  capabilities: {
    hasTestimonial: false,
    hasPackage: false,
    hasStudents: false,
    hasAvailability: false,
    hasPhoto: false,
  },
} as never;

function input(over: Record<string, unknown> = {}) {
  return {
    teacherId: "t1",
    context: CONTEXT,
    kind: "tip" as const,
    platform: "facebook_group" as const,
    promoPolicy: "open" as const,
    outputLanguage: "English",
    ...over,
  };
}

function toolReply(payload: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", name: MARKETING_CONTENT_TOOL.name, input: payload }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hasAnthropicCreds.mockReturnValue(true);
  rateLimit.mockResolvedValue({ ok: true });
});

describe("generateMarketingContent", () => {
  it("refuses without credentials, before the rate limiter is even consulted", async () => {
    hasAnthropicCreds.mockReturnValue(false);
    expect(await generateMarketingContent(input())).toEqual({
      ok: false,
      reason: "not-configured",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("throttles before paying for a call, and says how long to wait", async () => {
    rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 42_000 });
    expect(await generateMarketingContent(input())).toEqual({
      ok: false,
      reason: "throttled",
      retryAfterMs: 42_000,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("forces the structured tool, so a post arrives as fields not prose", async () => {
    create.mockResolvedValue(toolReply({ body: "A tip.", angleNote: "Practical." }));
    await generateMarketingContent(input());
    expect(create.mock.calls[0][0]).toMatchObject({
      tool_choice: { type: "tool", name: "emit_marketing_post" },
    });
  });

  it("returns the generated fields", async () => {
    create.mockResolvedValue(
      toolReply({ body: "A tip.", title: "Hi", angleNote: "Practical.", imageIdea: "a desk" }),
    );
    const result = await generateMarketingContent(input());
    expect(result).toMatchObject({
      ok: true,
      content: { body: "A tip.", title: "Hi", angleNote: "Practical.", imageIdea: "a desk" },
    });
  });

  it("drops a volunteered image idea for a kind that wants no image", async () => {
    create.mockResolvedValue(
      toolReply({ body: "x", angleNote: "y", imageIdea: "unsolicited picture" }),
    );
    const result = await generateMarketingContent(input({ kind: "community_reply" }));
    expect(result.ok && result.content.imageIdea).toBeNull();
  });

  it("treats a response with no tool call as empty rather than guessing", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "here you go!" }] });
    expect(await generateMarketingContent(input())).toEqual({ ok: false, reason: "empty" });
  });

  it("treats a malformed tool payload as empty", async () => {
    create.mockResolvedValue(toolReply({ angleNote: "no body at all" }));
    expect(await generateMarketingContent(input())).toEqual({ ok: false, reason: "empty" });
  });

  it("caps a runaway body before it reaches the teacher's clipboard", async () => {
    create.mockResolvedValue(toolReply({ body: "x".repeat(50_000), angleNote: "y" }));
    const result = await generateMarketingContent(input());
    // Twice the platform's soft limit — generous for a long post, mean enough
    // that a runaway is bounded.
    expect(result.ok && result.content.body.length).toBe(1400);
  });

  it("turns a provider failure into a retryable error, never a throw", async () => {
    create.mockRejectedValue(new Error("provider down"));
    expect(await generateMarketingContent(input())).toEqual({ ok: false, reason: "error" });
  });

  it("bounds max_tokens — a social post is short and a runaway costs money", async () => {
    create.mockResolvedValue(toolReply({ body: "x", angleNote: "y" }));
    await generateMarketingContent(input());
    expect(create.mock.calls[0][0].max_tokens).toBeLessThanOrEqual(2000);
  });
});
