import { describe, expect, it } from "vitest";
import { compareReports, formatReport, summarizeResults, type CaseResult } from "./report";

const NOW = new Date("2026-10-16T10:00:00.000Z");

const ok = (id: string) => ({ id, ok: true, detail: null });
const bad = (id: string, detail: string) => ({ id, ok: false, detail });

const results: CaseResult[] = [
  {
    surface: "lesson-insights",
    name: "a",
    model: "claude-haiku-4-5",
    checks: [ok("evidence-quoted"), ok("conservative")],
    error: null,
  },
  {
    surface: "lesson-insights",
    name: "b",
    model: "claude-haiku-4-5",
    checks: [bad("evidence-quoted", 'cites "x"'), ok("conservative")],
    error: null,
  },
  { surface: "homework-review", name: "c", model: null, checks: [], error: "boom" },
];

describe("summarizeResults", () => {
  it("rates each surface over its applicable checks and lists what failed", () => {
    const report = summarizeResults(results, NOW);
    expect(report.generatedAt).toBe("2026-10-16T10:00:00.000Z");
    expect(report.surfaces["lesson-insights"]).toEqual({
      cases: 2,
      errors: 0,
      checks: 4,
      passed: 3,
      passRate: 0.75,
      byCheck: {
        "evidence-quoted": { passed: 1, total: 2 },
        conservative: { passed: 2, total: 2 },
      },
      failures: [{ case: "b", check: "evidence-quoted", detail: 'cites "x"' }],
    });
  });

  it("counts a case that could not be scored as an error with an unknown rate, never a pass", () => {
    const report = summarizeResults(results, NOW);
    expect(report.surfaces["homework-review"]).toMatchObject({
      cases: 1,
      errors: 1,
      checks: 0,
      passRate: null,
      failures: [{ case: "c", check: "error", detail: "boom" }],
    });
  });
});

describe("formatReport", () => {
  it("names the model, the rate, the per-check tallies and each failure", () => {
    const text = formatReport(summarizeResults(results, NOW));
    expect(text).toContain("lesson-insights (claude-haiku-4-5): 75% — 3/4 checks over 2 cases");
    expect(text).toContain("evidence-quoted          1/2");
    expect(text).toContain('✗ b · evidence-quoted: cites "x"');
    expect(text).toContain("homework-review: n/a — 0/0 checks over 1 cases, 1 errored");
  });
});

describe("compareReports", () => {
  const baseline = summarizeResults(results, NOW);

  it("shows the rate moving and which checks and cases moved it", () => {
    const fixed = results.map((r) =>
      r.name === "b" ? { ...r, checks: [ok("evidence-quoted"), bad("conservative", "5 > 2")] } : r,
    );
    const text = compareReports(baseline, summarizeResults(fixed, NOW));
    expect(text).toContain("lesson-insights: 75% → 75%");
    expect(text).toContain("evidence-quoted          50% → 100%");
    expect(text).toContain("conservative             100% → 50%");
    expect(text).toContain("newly failing: b · conservative");
  });

  it("calls out a surface that is new or missing rather than skipping it", () => {
    const only = summarizeResults(
      results.filter((r) => r.surface === "lesson-insights"),
      NOW,
    );
    expect(compareReports(baseline, only)).toContain("homework-review: missing from this run");
    expect(compareReports(only, baseline)).toContain("homework-review: new in this run");
  });
});
