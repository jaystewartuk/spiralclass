// Automates /admin/uat's §K2 "open the dashboard and eyeball it" step:
// queries PostHog's HogQL Query API directly (server-side, using the
// existing POSTHOG_PERSONAL_API_KEY — already configured for local
// feature-flag evaluation, apps/web/src/lib/env.ts) for the events the
// runbook's earlier sections should have generated. See D-55.
import { serverEnv } from "@/lib/env";
import { posthogRegionHosts } from "@/lib/analytics/posthog-region";
import type { UatTargetEnv } from "./env-targets";

const EXPECTED_EVENTS = [
  "teacher_signed_in",
  "payout_rail_connected",
  "checkout_started",
  "payment_received",
  "booking_created",
] as const;

const WINDOW_MINUTES = 60;

type PostHogCheckResult = { label: string; pass: boolean; detail: string };
export type PostHogCheckReport = { env: UatTargetEnv; checks: PostHogCheckResult[]; pass: boolean };

type QueryRow = [event: string, lib: string | null, environment: string | null, count: number];

async function queryRecentEvents(): Promise<QueryRow[]> {
  const { POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID } = serverEnv();
  if (!POSTHOG_PERSONAL_API_KEY) {
    throw new Error("POSTHOG_PERSONAL_API_KEY is not configured");
  }
  // D-158: the project id is an account identifier, so it is configuration
  // rather than a constant. No fallback — a default that works is a committed
  // identifier with a switch beside it.
  if (!POSTHOG_PROJECT_ID) {
    throw new Error("POSTHOG_PROJECT_ID is not configured");
  }
  const host = posthogRegionHosts().ui;
  const query = `
    SELECT event, properties.$lib AS lib, properties.environment AS environment, count() AS cnt
    FROM events
    WHERE timestamp >= now() - INTERVAL ${WINDOW_MINUTES} MINUTE
    GROUP BY event, lib, environment
  `;
  const res = await fetch(`${host}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${POSTHOG_PERSONAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `PostHog query failed: HTTP ${res.status} — ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as { results?: QueryRow[] };
  return body.results ?? [];
}

export async function runPostHogCheck(env: UatTargetEnv): Promise<PostHogCheckReport> {
  const rows = await queryRecentEvents();
  const checks: PostHogCheckResult[] = [];

  const backendLive = rows.some((r) => r[1] === "posthog-node" && r[2] === env);
  checks.push({
    label: "backend-analytics-live",
    pass: backendLive,
    detail: backendLive
      ? `posthog-node events tagged environment=${env} seen in the last hour`
      : `no posthog-node events tagged environment=${env} — check POSTHOG_KEY is set on this Vercel environment`,
  });

  for (const eventName of EXPECTED_EVENTS) {
    const count = rows
      .filter((r) => r[0] === eventName && r[2] === env)
      .reduce((sum, r) => sum + r[3], 0);
    checks.push({
      label: eventName,
      pass: count > 0,
      detail: count > 0 ? `${count} event(s) in the last hour` : "not seen yet in the last hour",
    });
  }

  return { env, checks, pass: checks.every((c) => c.pass) };
}
