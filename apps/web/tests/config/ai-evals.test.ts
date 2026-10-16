import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_SURFACES, parseEvalCase } from "@/lib/evals/cases";
import { AI_CALL_SITES, unevaluatedSurfaces } from "@/lib/evals/registry";

// D-201: a model call site ships with an eval set. This holds the registry in
// lib/evals/registry.ts to the tree — every file that asks a model for words
// is listed, every surface it says it measures has cases, and the list of
// surfaces nobody measures can only shrink.

const WEB = resolve(__dirname, "../..");
const SRC = join(WEB, "src");
const CASES = join(WEB, "evals", "cases");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const callSites = [...walk(SRC)]
  .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
  .filter((p) => readFileSync(p, "utf8").includes("messages.create("))
  .map((p) => relative(WEB, p))
  .sort();

describe("every model call site is in the registry", () => {
  it("the files that call messages.create are exactly the registered ones", () => {
    expect(callSites).toEqual(AI_CALL_SITES.map((s) => s.file).sort());
  });

  it("each registered file still calls the model (retire the entry with the call)", () => {
    for (const site of AI_CALL_SITES) {
      expect(callSites, site.file).toContain(site.file);
    }
  });
});

describe("the unevaluated surfaces are a ratchet", () => {
  // Delete a line here when its surface gets a case set and a checker. Never
  // add one: a new prompt shape arrives with its eval (D-201).
  const ALLOWED_PENDING = [
    "intro-coach",
    "lesson-summary",
    "marketing-content",
    "material-compose",
    "material-compose-stream",
    "material-refine",
    "podcast-script",
    "pre-class-brief",
  ];

  it("no surface without an eval was added", () => {
    for (const surface of unevaluatedSurfaces()) {
      expect(ALLOWED_PENDING, `${surface} has no eval set`).toContain(surface);
    }
  });

  it("a surface marked evaluated has a checker", () => {
    for (const site of AI_CALL_SITES) {
      for (const surface of site.evaluated) {
        expect(EVAL_SURFACES).toContain(surface);
        expect(site.surfaces).toContain(surface);
      }
    }
  });
});

describe("the committed cases", () => {
  const evaluated = AI_CALL_SITES.flatMap((s) => s.evaluated);

  it("exist for every evaluated surface, and parse", () => {
    for (const surface of evaluated) {
      const dir = join(CASES, surface);
      expect(existsSync(dir), `${dir} is missing`).toBe(true);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files.length, `${surface} has no cases`).toBeGreaterThan(0);
      for (const file of files) {
        const c = parseEvalCase(JSON.parse(readFileSync(join(dir, file), "utf8")), file);
        expect(c.surface).toBe(surface);
        expect(`${c.name}.json`, "a case file is named after its case").toBe(file);
      }
    }
  });

  it("every case directory is for a surface that is evaluated", () => {
    for (const dir of readdirSync(CASES)) {
      expect(evaluated, `evals/cases/${dir} has no checker`).toContain(dir);
    }
  });

  it("name nobody real — committed cases are synthetic", () => {
    // Real transcripts are personal data and live outside the repository
    // (EVAL_CASES_DIR). A fixture student is named like one.
    const text = [...walk(CASES)].map((p) => readFileSync(p, "utf8")).join("\n");
    expect(text, "no email address").not.toMatch(/@/);
    expect(text, "no phone number").not.toMatch(/\+\d[\d\s-]{6,}/);
  });
});

describe("the runner", () => {
  it("is wired as `pnpm evals` from the root and the workspace", () => {
    const web = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const root = JSON.parse(readFileSync(join(WEB, "../../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(web.scripts.evals).toContain("scripts/evals.ts");
    expect(root.scripts.evals).toContain("spiralclass-web evals");
    expect(existsSync(join(WEB, "scripts/evals.ts"))).toBe(true);
  });

  it("uses the production default model for the homework review surface", () => {
    // The runner cannot import lib/env.ts (server logger), so it restates the
    // default; this is what keeps the two from drifting.
    const runner = readFileSync(join(WEB, "scripts/evals.ts"), "utf8");
    const env = readFileSync(join(SRC, "lib/env.ts"), "utf8");
    const fromEnv = /ANTHROPIC_MODEL \?\? "([^"]+)"/.exec(env)?.[1];
    const fromRunner = /HOMEWORK_REVIEW_DEFAULT_MODEL = "([^"]+)"/.exec(runner)?.[1];
    expect(fromEnv).toBeTruthy();
    expect(fromRunner).toBe(fromEnv);
  });

  it("is not a gate step — it spends money and scores rather than passes", () => {
    const steps = readFileSync(join(WEB, "../../scripts/ci/steps.mjs"), "utf8");
    expect(steps).not.toContain("evals");
  });
});
