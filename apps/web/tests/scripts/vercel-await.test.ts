import { describe, expect, it } from "vitest";

import {
  awaitDeployment,
  deploymentRef,
  IN_PROGRESS,
  verdict,
} from "../../../../scripts/vercel-await.mjs";
import { vercelClient, type VercelDeployment } from "../../../../scripts/vercel-env.mjs";

/**
 * scripts/vercel-await.mjs is what the failover deploy waits on, instead of the
 * Vercel CLI's own wait. On 2026-09-18 and 2026-09-19 Vercel put the failover's
 * deployment in BLOCKED — its commit-author check — and the CLI, which
 * leaves its poll loop only on READY, ERROR or CANCELED, printed "Building…"
 * until the job's 30-minute timeout cancelled it. Twice, with nothing in the log
 * saying what Vercel had decided.
 *
 * The property held here is the inverse of the CLI's: only a state known to be
 * in progress is waited on, everything else fails at once with Vercel's reason,
 * and even an in-progress state is waited on for a bounded time. Every case runs
 * the real loop on a fake clock.
 */

/** A BLOCKED deployment, shaped as GET /v13/deployments returned it on 2026-09-19. */
const BLOCKED: VercelDeployment = {
  id: "dpl_blocked",
  url: "spiralclass-abc123-team.vercel.app",
  readyState: "BLOCKED",
  readySubstate: "STAGED",
  errorLink:
    "https://vercel.com/docs/deployments/troubleshoot-project-collaboration#team-configuration",
  meta: { githubCommitAuthorEmail: "1+someone@users.noreply.github.com" },
};

/** Runs the loop against a scripted sequence of API answers, on a fake clock. */
async function run(
  answers: (VercelDeployment | Error)[],
  { timeoutMs = 60_000, intervalMs = 5_000 } = {},
) {
  let clock = 0;
  let calls = 0;
  const lines: string[] = [];
  const code = await awaitDeployment({
    ref: "spiralclass-abc123-team.vercel.app",
    get: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: (line) => lines.push(line),
    timeoutMs,
    intervalMs,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { code, calls, lines, text: lines.join("\n"), elapsedMs: clock };
}

const httpError = (status: number) =>
  Object.assign(new Error(`Vercel API GET /v13/deployments/x: HTTP ${status}`), { status });

describe("the failover deploy fails on a deployment Vercel will not finish", () => {
  it("fails at once on BLOCKED, and says what Vercel checks and where to fix it", async () => {
    // The regression. The CLI waited 30 minutes on exactly this answer.
    const { code, calls, text, elapsedMs } = await run([BLOCKED]);
    expect(code).toBe(1);
    expect(calls, "a BLOCKED deployment was polled again").toBe(1);
    expect(elapsedMs).toBe(0);
    expect(text).toContain("BLOCKED / STAGED");
    expect(text).toContain("1+someone@users.noreply.github.com");
    expect(text).toContain("Login Connections");
    expect(text).toContain(BLOCKED.errorLink);
  });

  it("fails on ERROR and CANCELED with Vercel's own error", async () => {
    const error = await run([
      { readyState: "ERROR", errorCode: "BUILD_FAILED", errorMessage: "Command exited with 1" },
    ]);
    expect(error.code).toBe(1);
    expect(error.text).toContain("BUILD_FAILED: Command exited with 1");

    expect((await run([{ readyState: "CANCELED" }])).code).toBe(1);
  });

  it("fails on a state it has never heard of, rather than waiting on it", async () => {
    // BLOCKED was a state the CLI had never heard of. The next one will be too.
    const { code, calls } = await run([{ readyState: "SOMETHING_NEW" }]);
    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(verdict({}).done, "a deployment with no state is waited on").toBe(true);
  });

  it("waits through the in-progress states and passes on READY", async () => {
    const { code, lines } = await run([
      { readyState: "QUEUED" },
      { readyState: "INITIALIZING" },
      { readyState: "BUILDING" },
      { readyState: "BUILDING" },
      { readyState: "READY" },
    ]);
    expect(code).toBe(0);
    // One line per change of state, not one per poll.
    expect(lines.filter((l) => l.includes("BUILDING"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("READY");
  });

  it("only QUEUED, INITIALIZING and BUILDING are waited on", () => {
    // Widening this set is how the CLI's hang comes back.
    expect([...IN_PROGRESS].sort()).toEqual(["BUILDING", "INITIALIZING", "QUEUED"]);
  });

  it("gives up on an in-progress state at the deadline", async () => {
    const { code, text, elapsedMs } = await run([{ readyState: "QUEUED" }], {
      timeoutMs: 60_000,
    });
    expect(code).toBe(1);
    expect(text).toContain("still QUEUED after 60s");
    expect(elapsedMs).toBeLessThanOrEqual(60_000 + 5_000);
  });

  it("fails at once on a 4xx, which asking again will not change", async () => {
    const { code, calls, text } = await run([httpError(403)]);
    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(text).toContain("HTTP 403");
  });

  it("rides out a transient 5xx, and gives up if it does not pass", async () => {
    expect((await run([httpError(502), httpError(503), { readyState: "READY" }])).code).toBe(0);
    expect((await run([httpError(429), { readyState: "READY" }])).code).toBe(0);

    const stuck = await run([httpError(502)], { timeoutMs: 10 * 60_000 });
    expect(stuck.code).toBe(1);
    expect(stuck.calls).toBe(5);
  });
});

describe("the await reads the deployment the CLI printed", () => {
  it("takes the https URL the CLI writes to stdout", () => {
    expect(deploymentRef("https://spiralclass-abc123-team.vercel.app")).toBe(
      "spiralclass-abc123-team.vercel.app",
    );
    expect(deploymentRef("  https://spiralclass-abc123-team.vercel.app\n")).toBe(
      "spiralclass-abc123-team.vercel.app",
    );
  });

  it("takes the last URL, and never a version number", () => {
    expect(
      deploymentRef("Vercel CLI 59.15.1\nhttps://a.vercel.app\nhttps://spiralclass-x.vercel.app"),
    ).toBe("spiralclass-x.vercel.app");
    expect(deploymentRef("Vercel CLI 59.15.1")).toBeNull();
  });

  it("takes a bare host or a deployment id, and nothing else", () => {
    expect(deploymentRef("spiralclass-x.vercel.app")).toBe("spiralclass-x.vercel.app");
    expect(deploymentRef("dpl_0123456789abcdefABCDEF")).toBe("dpl_0123456789abcdefABCDEF");
    expect(deploymentRef("")).toBeNull();
    expect(deploymentRef(undefined)).toBeNull();
  });

  it("asks the v13 deployments endpoint, scoped to the team, with the token in a header", async () => {
    const requests: { url: string; auth?: string }[] = [];
    const client = vercelClient({
      token: "tok",
      teamId: "team_1",
      projectId: "prj_1",
      fetch: (async (url: string, init: RequestInit = {}) => {
        requests.push({
          url,
          auth: (init.headers as Record<string, string> | undefined)?.Authorization,
        });
        return new Response(JSON.stringify(BLOCKED), { status: 200 });
      }) as typeof globalThis.fetch,
    });

    expect((await client.deployment("spiralclass-abc123-team.vercel.app")).readyState).toBe(
      "BLOCKED",
    );
    expect(requests).toEqual([
      {
        url: "https://api.vercel.com/v13/deployments/spiralclass-abc123-team.vercel.app?teamId=team_1",
        auth: "Bearer tok",
      },
    ]);
  });

  it("puts the HTTP status on a failed call, which is what tells a 4xx from a 5xx", async () => {
    const client = vercelClient({
      token: "tok",
      teamId: "team_1",
      projectId: "prj_1",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "forbidden" } }), {
          status: 403,
        })) as typeof globalThis.fetch,
    });
    await expect(client.deployment("x.vercel.app")).rejects.toMatchObject({ status: 403 });
  });
});
