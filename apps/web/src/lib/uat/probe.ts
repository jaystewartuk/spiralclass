// Reimplements the two checks from apps/web/scripts/uat-probe.sh in plain
// TS `fetch()` so /admin/uat can run them from a server action — no
// child_process (there's no precedent for shelling out in this codebase,
// and Vercel's serverless runtime isn't a place to invoke bash/tsx). The
// bash script stays as-is for CLI/local use; this is a small deliberate
// duplication of the same two checks, not a shared-code refactor. See D-55.
import { UAT_TARGET_BASE_URL, type UatTargetEnv } from "./env-targets";

export type ProbeCheckResult = { label: string; pass: boolean; detail: string };
export type ProbeResult = {
  env: UatTargetEnv;
  baseUrl: string;
  checks: ProbeCheckResult[];
  pass: boolean;
};

async function checkHealth(baseUrl: string): Promise<ProbeCheckResult> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { db?: string } | null;
    const pass = res.status === 200 && body?.db === "ok";
    return {
      label: "health",
      pass,
      detail: pass ? "200, db:ok" : `got HTTP ${res.status} — ${JSON.stringify(body)}`,
    };
  } catch (err) {
    return { label: "health", pass: false, detail: `request failed: ${(err as Error).message}` };
  }
}

async function checkWebhookRefusal(baseUrl: string): Promise<ProbeCheckResult> {
  try {
    const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=garbage" },
      body: JSON.stringify({ id: "evt_uat_probe", type: "ping" }),
      signal: AbortSignal.timeout(15_000),
    });
    const pass = res.status === 401;
    let detail = `got HTTP ${res.status}, expected 401`;
    if (res.status === 200) detail += " (signature verification BYPASSED — HARD BLOCKER)";
    if (res.status === 503) detail += " (STRIPE_WEBHOOK_SECRET missing on the deploy — redeploy)";
    return { label: "webhook-refusal", pass, detail };
  } catch (err) {
    return {
      label: "webhook-refusal",
      pass: false,
      detail: `request failed: ${(err as Error).message}`,
    };
  }
}

export async function runUatProbe(env: UatTargetEnv): Promise<ProbeResult> {
  const baseUrl = UAT_TARGET_BASE_URL[env];
  const checks = await Promise.all([checkHealth(baseUrl), checkWebhookRefusal(baseUrl)]);
  return { env, baseUrl, checks, pass: checks.every((c) => c.pass) };
}
