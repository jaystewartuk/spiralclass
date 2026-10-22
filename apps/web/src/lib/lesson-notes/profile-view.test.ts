import { describe, expect, it } from "vitest";
import { buildProfileView, HINT_MAX_CHARS, truncateHint } from "./profile-view";

const entry = (
  recurrenceCount: number,
  trend: "focus" | "improving" | "new",
  ev: string | null,
) => ({
  recurrenceCount,
  firstSeenAt: "2026-10-01T10:00:00.000Z",
  lastSeenAt: "2026-10-20T10:00:00.000Z",
  trend,
  lastEvidence: ev,
});

describe("truncateHint", () => {
  it("returns null for empty or whitespace evidence", () => {
    expect(truncateHint(null)).toBeNull();
    expect(truncateHint("  \n ")).toBeNull();
  });
  it("keeps a short quote and collapses whitespace", () => {
    expect(truncateHint("I   go\nyesterday")).toBe("I go yesterday");
  });
  it("cuts a long quote to the limit with an ellipsis", () => {
    const out = truncateHint("x".repeat(300))!;
    expect(out.length).toBe(HINT_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildProfileView", () => {
  const raw = {
    byCategory: {
      grammar: { subjunctive: entry(3, "focus", "q1"), articles: entry(1, "improving", null) },
      fluency: { filler_words: entry(2, "focus", "um, eh, este"), pace: entry(5, "new", null) },
      comprehension: { listening: entry(1, "new", null) },
    },
    vocabulary: [{ term: "madrugada", lastSeenAt: "2026-10-20T10:00:00.000Z" }],
  };

  it("splits fluency and comprehension into signals, ordered by recurrence", () => {
    const v = buildProfileView(raw);
    expect(v.signals.map((r) => r.skill)).toEqual(["pace", "filler_words", "listening"]);
    expect(v.focus.map((r) => r.skill)).toEqual(["subjunctive", "articles"]);
  });

  it("breaks recurrence ties by trend, focus first", () => {
    const v = buildProfileView({
      byCategory: { grammar: { a: entry(2, "improving", null), b: entry(2, "focus", null) } },
      vocabulary: [],
    });
    expect(v.focus.map((r) => r.skill)).toEqual(["b", "a"]);
  });

  it("carries a truncated hint and no timestamps", () => {
    const row = buildProfileView(raw).signals.find((r) => r.skill === "filler_words")!;
    expect(row.hint).toBe("um, eh, este");
    expect(Object.keys(row)).not.toContain("lastSeenAt");
    expect(Object.keys(row)).not.toContain("firstSeenAt");
  });

  it("lists vocabulary terms only", () => {
    expect(buildProfileView(raw).vocabulary).toEqual(["madrugada"]);
  });

  it("degrades a missing or malformed profile to an empty view", () => {
    const empty = { signals: [], focus: [], vocabulary: [] };
    expect(buildProfileView(null)).toEqual(empty);
    expect(buildProfileView({ nonsense: true })).toEqual(empty);
  });
});
