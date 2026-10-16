// Run the model evals (D-201; docs/development/testing.md, "Model evals").
//
//   pnpm evals                              live run, committed cases, default models
//   pnpm evals -- --cases ~/evals/private   add a private case directory (or EVAL_CASES_DIR)
//   pnpm evals -- --record out/run-a        live run, saving every output for re-scoring
//   pnpm evals -- --replay out/run-a        score saved outputs; no network, no key
//   pnpm evals -- --model claude-x --out b.json --baseline a.json
//                                           candidate model, report saved, delta printed
//   pnpm evals -- --surface homework-review one surface only
//
// A live run needs ANTHROPIC_API_KEY in the process environment — exported in
// the shell, or on the command line. The committed local runtime env holds no
// vendor key on purpose, and a package script may not read a private env file
// (tests/config/no-private-env-files.test.ts); the environment is the first
// source by design (config/env/README.md). It is never part of the gate: it spends money, needs the network and
// scores rather than passes. Exit code is 0 unless a case could not be loaded
// or no case ran — a low score is a finding for the PR, not a build failure.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { parseEvalCase, type EvalCase, type EvalSurface } from "@/lib/evals/cases";
import { checkHomeworkReview, checkLessonInsights, type Check } from "@/lib/evals/checks";
import {
  compareReports,
  formatReport,
  summarizeResults,
  type CaseResult,
  type EvalReport,
} from "@/lib/evals/report";
import {
  AI_REVIEW_TOOL,
  buildAiReviewPrompt,
  parseAiReviewToolInput,
} from "@/lib/homework/ai-review-prompt";
import {
  generateInsights,
  INSIGHTS_MODEL,
  parseInsightsToolInput,
} from "@/lib/lesson-notes/insights";
import type { HomeworkAiReviewContent } from "@spiralclass/shared";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const COMMITTED_CASES = join(WEB_ROOT, "evals", "cases");

// The production default for anthropicModel() (lib/env.ts). Read here rather
// than imported because lib/env.ts pulls the server logger; a drift between
// the two is caught by the guard in tests/config/ai-evals.test.ts.
export const HOMEWORK_REVIEW_DEFAULT_MODEL = "claude-sonnet-5";

type Args = {
  cases: string[];
  record: string | null;
  replay: string | null;
  out: string | null;
  baseline: string | null;
  surface: EvalSurface | null;
  model: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cases: [],
    record: null,
    replay: null,
    out: null,
    baseline: null,
    surface: null,
    model: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    // pnpm forwards the `--` separator itself.
    if (flag === "--") continue;
    const value = argv[i + 1];
    const take = () => {
      if (value == null || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      i++;
      return value;
    };
    switch (flag) {
      case "--cases":
        args.cases.push(take());
        break;
      case "--record":
        args.record = take();
        break;
      case "--replay":
        args.replay = take();
        break;
      case "--out":
        args.out = take();
        break;
      case "--baseline":
        args.baseline = take();
        break;
      case "--surface":
        args.surface = take() as EvalSurface;
        break;
      case "--model":
        args.model = take();
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (args.record && args.replay) throw new Error("--record and --replay are exclusive");
  return args;
}

function* jsonFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(path);
    else if (entry.name.endsWith(".json")) yield path;
  }
}

function loadCases(dirs: string[], surface: EvalSurface | null): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) throw new Error(`case directory not found: ${dir}`);
    for (const file of jsonFiles(dir)) {
      const c = parseEvalCase(JSON.parse(readFileSync(file, "utf8")), file);
      if (!surface || c.surface === surface) cases.push(c);
    }
  }
  const seen = new Set<string>();
  for (const c of cases) {
    const key = `${c.surface}/${c.name}`;
    if (seen.has(key)) throw new Error(`two cases named ${key}`);
    seen.add(key);
  }
  return cases;
}

type Recorded = { model: string | null; recordedAt: string; output: unknown };

function recordedPath(dir: string, c: EvalCase) {
  return join(dir, c.surface, `${c.name}.json`);
}

async function homeworkReviewLive(
  input: Parameters<typeof buildAiReviewPrompt>[0],
  model: string,
): Promise<HomeworkAiReviewContent | null> {
  // The same request generateHomeworkAiReview sends (lib/ai/anthropic.ts),
  // rebuilt here because that module is `server-only` and cannot load
  // outside Next. Keep the two in step.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { system, user } = buildAiReviewPrompt(input);
  const message = await client.messages.create({
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: user }],
    tools: [AI_REVIEW_TOOL],
    tool_choice: { type: "tool", name: AI_REVIEW_TOOL.name },
  });
  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === AI_REVIEW_TOOL.name,
  );
  return toolUse ? parseAiReviewToolInput(toolUse.input) : null;
}

async function obtainOutput(
  c: EvalCase,
  args: Args,
): Promise<{ model: string | null; output: unknown }> {
  if (args.replay) {
    const path = recordedPath(args.replay, c);
    if (!existsSync(path)) throw new Error(`no recorded output at ${path}`);
    const rec = JSON.parse(readFileSync(path, "utf8")) as Recorded;
    return { model: rec.model, output: rec.output };
  }
  switch (c.surface) {
    case "lesson-insights": {
      const model = args.model ?? INSIGHTS_MODEL;
      return { model, output: await generateInsights(c.input, { model }) };
    }
    case "homework-review": {
      const model = args.model ?? HOMEWORK_REVIEW_DEFAULT_MODEL;
      return { model, output: await homeworkReviewLive(c.input, model) };
    }
  }
}

function score(c: EvalCase, output: unknown): Check[] {
  switch (c.surface) {
    case "lesson-insights":
      // Recorded outputs went through the parser once; running it again is
      // idempotent and keeps a hand-edited recording honest.
      return checkLessonInsights(c, parseInsightsToolInput({ insights: output }));
    case "homework-review":
      return checkHomeworkReview(c, output == null ? null : parseAiReviewToolInput(output));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = [COMMITTED_CASES, ...args.cases];
  if (process.env.EVAL_CASES_DIR) dirs.push(process.env.EVAL_CASES_DIR);
  const cases = loadCases(dirs, args.surface);
  if (cases.length === 0) throw new Error("no cases matched");
  if (!args.replay && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set: export it in your shell (ANTHROPIC_API_KEY=… pnpm evals), or use --replay to score recorded outputs",
    );
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    try {
      const { model, output } = await obtainOutput(c, args);
      if (args.record) {
        const path = recordedPath(args.record, c);
        mkdirSync(dirname(path), { recursive: true });
        const rec: Recorded = { model, recordedAt: new Date().toISOString(), output };
        writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
      }
      results.push({
        surface: c.surface,
        name: c.name,
        model,
        checks: score(c, output),
        error: null,
      });
    } catch (err) {
      results.push({
        surface: c.surface,
        name: c.name,
        model: null,
        checks: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  const report = summarizeResults(results);
  console.log(formatReport(report));
  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nreport written to ${args.out}`);
  }
  if (args.baseline) {
    const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as EvalReport;
    console.log(`\nagainst ${args.baseline}:\n${compareReports(baseline, report)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
