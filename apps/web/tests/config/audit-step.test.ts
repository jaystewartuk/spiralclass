import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isTransportFailure,
  reachedTheDatabase,
  verdictFor,
} from "../../../../scripts/ci/audit.mjs";
import { STEPS } from "../../../../scripts/ci/steps.mjs";

const repoRoot = resolve(__dirname, "../../../..");
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), "utf8");

// 2026-09-03: npm's `security/advisories/bulk` endpoint went down, on and off,
// for over an hour. registry.npmjs.org itself served fine. `pnpm audit` exited
// non-zero with a TimeoutError, the gate read that as a high-severity finding,
// and EVERY push, merge, promote and deploy was blocked in both tiers — while
// learning nothing about any dependency.
//
// The audit now separates the two. What these lock is that the separation
// stays honest in the direction that matters: a real finding must never be
// able to take the "npm was unreachable" exit.
describe("the dependency audit tells a verdict from an outage", () => {
  // Real output, copied from .gate/logs on the day.
  const TIMEOUT_OUTPUT = `[WARN] POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23). Will retry in 10 seconds. 2 retries left.
[WARN] POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23). Will retry in 1 minute. 1 retries left.
[23] The operation was aborted due to timeout

TimeoutError: The operation was aborted due to timeout
    at new DOMException (node:internal/per_context/domexception:76:18)`;

  const FINDINGS_OUTPUT = `┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ Prototype pollution in some-package                    │
└─────────────────────┴────────────────────────────────────────────────────────┘
16 vulnerabilities found
Severity: 10 moderate | 6 high (2 ignored)`;

  // The endpoint blipped, the retry worked, and the audit answered. That is a
  // verdict, not an outage — and the timeout line is still in the output.
  const BLIP_THEN_ANSWER = `[WARN] POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23). Will retry in 10 seconds. 2 retries left.
16 vulnerabilities found
Severity: 10 moderate | 6 high (2 ignored)`;

  it("skips only when the database never answered", () => {
    expect(verdictFor(TIMEOUT_OUTPUT)).toBe("skip");
    expect(isTransportFailure(TIMEOUT_OUTPUT)).toBe(true);
    expect(reachedTheDatabase(TIMEOUT_OUTPUT)).toBe(false);
  });

  it("fails on findings, which is the whole point of the step", () => {
    expect(verdictFor(FINDINGS_OUTPUT)).toBe("fail");
    expect(reachedTheDatabase(FINDINGS_OUTPUT)).toBe(true);
  });

  // The dangerous case: output that contains BOTH a timeout line and a real
  // count. An answer always wins, or a single retried request would be enough
  // to launder a genuine finding into a skip.
  it("fails when a retry timed out but the audit still answered", () => {
    expect(isTransportFailure(BLIP_THEN_ANSWER)).toBe(true);
    expect(reachedTheDatabase(BLIP_THEN_ANSWER)).toBe(true);
    expect(verdictFor(BLIP_THEN_ANSWER)).toBe("fail");
  });

  it("fails closed on an error it does not recognise", () => {
    // Anything unclassifiable is a failure. A new pnpm error shape must not
    // silently become a skip.
    expect(verdictFor("ERR_PNPM_SOMETHING_NEW  audit could not complete")).toBe("fail");
    expect(verdictFor("")).toBe("fail");
  });

  it("is what the gate actually runs", () => {
    const audit = STEPS.find((s) => s.id === "audit");
    if (!audit) throw new Error("the gate has no audit step at all");
    expect(audit.cmd).toEqual(["node", "scripts/ci/audit.mjs"]);
    // Still fast tier: the point was never to run it less often.
    expect(audit.tier).toBe("fast");
  });

  it("still asks for prod dependencies at high severity", () => {
    // The wrapper must not quietly widen or narrow what is audited.
    const src = read("scripts", "ci", "audit.mjs");
    expect(src).toContain('"--prod"');
    expect(src).toContain('"--audit-level", "high"');
  });

  it("says out loud that a skipped audit is not a pass", () => {
    const src = read("scripts", "ci", "audit.mjs");
    expect(src).toContain("AUDIT SKIPPED");
    expect(src).toMatch(/This is NOT a pass/);
  });
});
