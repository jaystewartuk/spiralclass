// Turning per-case checks into the figure a PR quotes (D-201): per surface,
// the pass rate across every applicable check, the weakest checks, and the
// delta against a saved baseline. The JSON report is what a model-change PR
// attaches before and after.

import type { Check } from "./checks";

export type CaseResult = {
  surface: string;
  name: string;
  // The model id the output came from, when known.
  model: string | null;
  checks: Check[];
  // Set when the case could not be scored at all (the call threw, the
  // recorded output was missing). Counts against the surface, never silently.
  error: string | null;
};

export type SurfaceSummary = {
  cases: number;
  errors: number;
  checks: number;
  passed: number;
  // passed / checks, or null when nothing ran.
  passRate: number | null;
  byCheck: Record<string, { passed: number; total: number }>;
  failures: { case: string; check: string; detail: string | null }[];
};

export type EvalReport = {
  generatedAt: string;
  surfaces: Record<string, SurfaceSummary>;
  results: CaseResult[];
};

export function summarizeResults(results: CaseResult[], now = new Date()): EvalReport {
  const surfaces: Record<string, SurfaceSummary> = {};
  for (const r of results) {
    const s = (surfaces[r.surface] ??= {
      cases: 0,
      errors: 0,
      checks: 0,
      passed: 0,
      passRate: null,
      byCheck: {},
      failures: [],
    });
    s.cases += 1;
    if (r.error) {
      s.errors += 1;
      s.failures.push({ case: r.name, check: "error", detail: r.error });
    }
    for (const c of r.checks) {
      s.checks += 1;
      const by = (s.byCheck[c.id] ??= { passed: 0, total: 0 });
      by.total += 1;
      if (c.ok) {
        s.passed += 1;
        by.passed += 1;
      } else {
        s.failures.push({ case: r.name, check: c.id, detail: c.detail });
      }
    }
  }
  for (const s of Object.values(surfaces)) {
    s.passRate = s.checks === 0 ? null : s.passed / s.checks;
  }
  return { generatedAt: now.toISOString(), surfaces, results };
}

const pct = (rate: number | null) => (rate == null ? "n/a" : `${Math.round(rate * 100)}%`);

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const [surface, s] of Object.entries(report.surfaces)) {
    const models = [
      ...new Set(report.results.filter((r) => r.surface === surface).map((r) => r.model)),
    ]
      .filter((m): m is string => m != null)
      .join(", ");
    lines.push(
      `${surface}${models ? ` (${models})` : ""}: ${pct(s.passRate)} — ${s.passed}/${s.checks} checks over ${s.cases} cases` +
        (s.errors ? `, ${s.errors} errored` : ""),
    );
    for (const [id, by] of Object.entries(s.byCheck).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${id.padEnd(24)} ${by.passed}/${by.total}`);
    }
    for (const f of s.failures) {
      lines.push(`  ✗ ${f.case} · ${f.check}${f.detail ? `: ${f.detail}` : ""}`);
    }
  }
  return lines.join("\n");
}

// What moved between two reports. A surface in one and not the other is
// reported rather than ignored: a run that quietly dropped a surface would
// otherwise read as an improvement.
export function compareReports(baseline: EvalReport, current: EvalReport): string {
  const lines: string[] = [];
  const names = new Set([...Object.keys(baseline.surfaces), ...Object.keys(current.surfaces)]);
  for (const surface of [...names].sort()) {
    const before = baseline.surfaces[surface];
    const after = current.surfaces[surface];
    if (!before) {
      lines.push(`${surface}: new in this run (${pct(after!.passRate)})`);
      continue;
    }
    if (!after) {
      lines.push(`${surface}: missing from this run (was ${pct(before.passRate)})`);
      continue;
    }
    lines.push(`${surface}: ${pct(before.passRate)} → ${pct(after.passRate)}`);
    const ids = new Set([...Object.keys(before.byCheck), ...Object.keys(after.byCheck)]);
    for (const id of [...ids].sort()) {
      const b = before.byCheck[id];
      const a = after.byCheck[id];
      const bRate = b ? b.passed / b.total : null;
      const aRate = a ? a.passed / a.total : null;
      if (bRate === aRate) continue;
      lines.push(`  ${id.padEnd(24)} ${pct(bRate)} → ${pct(aRate)}`);
    }
    const wasFailing = new Set(before.failures.map((f) => `${f.case}·${f.check}`));
    for (const f of after.failures) {
      if (!wasFailing.has(`${f.case}·${f.check}`))
        lines.push(`  newly failing: ${f.case} · ${f.check}`);
    }
  }
  return lines.join("\n");
}
