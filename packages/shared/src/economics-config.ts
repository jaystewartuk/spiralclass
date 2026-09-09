// SpiralClass — Financial Intelligence taxonomy + integration seed (D-86).
//
// The estimate layer's cost categories and usage meters. Both are curated,
// extensible `as const` lists (NOT Prisma enums) so a new category, metric, or
// integration is a data change that needs no migration — the same migration-free
// posture `KNOWN_EXPENSE_VENDORS` takes in expenses-config.ts. Shared so web
// (and, later, a mobile mirror) resolve the same sets.
//
// This is deliberately SEPARATE from expenses-config.ts's `EXPENSE_CATEGORIES`
// (7 values, the ACTUALS taxonomy that's load-bearing across money-metrics.ts
// and the /admin/costs page). The estimate layer classifies infrastructure by
// what it IS (13 categories), not how an invoice was bucketed; coupling the two
// would drag the actuals page into every change here. See D-86.

import type { PricingModel } from "./economics-pricing";

// Infra classification for the estimate layer. `other` is the catch-all and the
// default for an integration whose category isn't set.
export const INTEGRATION_CATEGORIES = [
  "ai",
  "video",
  "hosting",
  "database",
  "storage",
  "analytics",
  "authentication",
  "email",
  "payments",
  "notifications",
  "monitoring",
  "dev_tools",
  "other",
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const DEFAULT_INTEGRATION_CATEGORY: IntegrationCategory = "other";

// The usage meters cost estimates are driven by. Manually entered per month for
// the MVP (UsageInput rows); a later Inngest job can populate them from the
// Booking / ClassContentGeneration / CallRecording / Notification tables with
// no change here. Values are counts / GB / minutes — never money.
export const USAGE_METRICS = [
  "teachers",
  "students",
  "lessons",
  "ai_generations",
  "video_minutes",
  "storage_gb",
  "emails",
  "notifications",
  "recordings",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export function isIntegrationCategory(value: string): value is IntegrationCategory {
  return (INTEGRATION_CATEGORIES as readonly string[]).includes(value);
}

export function isUsageMetric(value: string): value is UsageMetric {
  return (USAGE_METRICS as readonly string[]).includes(value);
}

// --- Seed registry ---------------------------------------------------------

// A default integration. `key` is the stable slug used for idempotent
// create-if-absent seeding (seed-registry.ts, S2) — it never clobbers an
// admin's edited row. `currency` is the model's native billing currency (mostly
// USD); the FX layer converts to the GBP display currency.
export type KnownIntegration = {
  key: string;
  name: string;
  category: IntegrationCategory;
  currency: string;
  purpose: string;
  pricingModel: PricingModel;
  billingModel: string;
  billingUrl?: string;
  docsUrl?: string;
};

// Rate cards calibrated 2026-07-19 against the app's own docs/deployment/COST_PLAYBOOK.md
// (documented plans + free quotas) AND live public pricing pages. Amounts/rates
// are in the entry's `currency` minor units (USD cents here); rates may be
// fractional (sub-cent per unit). These are the CURRENT plan this small app
// runs on — still tune per row in the admin UI; the seed never overwrites an
// edited row.
//
// METER CONFLATION (important, see D-86 usage-extract): the 9 USAGE_METRICS are
// coarse, so multiple providers can key off ONE meter and each bills the full
// amount:
//   • `video_minutes` drives deepgram/assemblyai (LessonAudio transcription
//     minutes) AND azure_speech (pronunciation audio) AND livekit
//     (call/intro participant-minutes) — physically different minutes.
//   • `emails` drives resend AND amazon_ses — but only ONE rail is active at a
//     time (EMAIL_PROVIDER prefers SES); deactivate the unused one in the UI.
//   • `ai_generations` drives anthropic_api (google_tts is modelled free below
//     to avoid double-counting the same meter).
// Split a meter (USAGE_METRICS is migration-free) if you need per-provider
// precision; for the MVP the absolute £ error is tiny at current volume.
export const KNOWN_INTEGRATIONS: readonly KnownIntegration[] = [
  // Hosting / infra
  {
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    currency: "USD",
    purpose: "Production web app hosting (preview is on Fly, D-70).",
    pricingModel: { kind: "free" },
    billingModel:
      "Hobby ($0): 100 GB bandwidth, 100k function invocations/mo — but non-commercial; a revenue product needs Pro ($20/mo)",
    billingUrl: "https://vercel.com/dashboard/usage",
    docsUrl: "https://vercel.com/docs/limits",
  },
  {
    key: "fly_io",
    name: "Fly.io",
    category: "hosting",
    currency: "USD",
    purpose: "Self-hosted Docker for the preview environment (D-70).",
    pricingModel: { kind: "monthly", amountMinor: 200, currency: "USD" },
    billingModel:
      "Pay-as-you-go machines (~$2/mo for one shared-cpu-1x 256 MB always-on VM); no free tier",
    billingUrl: "https://fly.io/dashboard",
    docsUrl: "https://fly.io/docs/about/pricing/",
  },
  {
    key: "neon",
    name: "Neon",
    category: "database",
    currency: "USD",
    purpose: "Serverless Postgres — the primary database (replaced Supabase DB, D-70).",
    pricingModel: { kind: "free", freeTier: { metric: "storage_gb", allowance: 0.5 } },
    billingModel: "Free (~0.5 GB storage, 190 compute-hrs/mo); Launch ~$19/mo above the free tier",
    billingUrl: "https://console.neon.tech/",
    docsUrl: "https://neon.tech/pricing",
  },
  {
    key: "cloudflare_r2",
    name: "Cloudflare R2",
    category: "storage",
    currency: "USD",
    purpose: "Object storage for message media, podcasts, and recordings.",
    pricingModel: {
      kind: "payg",
      metric: "storage_gb",
      unit: "GB-month",
      ratePerUnit: 1.5,
      includedUnits: 10,
      currency: "USD",
    },
    billingModel:
      "$0.015/GB-month above 10 GB free; Class A ops $4.50/M, Class B $0.36/M; egress free. Storage is NOT in Postgres — enter storage_gb manually.",
    billingUrl: "https://dash.cloudflare.com/?to=/:account/r2",
    docsUrl: "https://developers.cloudflare.com/r2/pricing/",
  },
  {
    key: "upstash_redis",
    name: "Upstash Redis",
    category: "database",
    currency: "USD",
    purpose: "Rate-limiting store.",
    pricingModel: { kind: "free" },
    billingModel: "Free (256 MB, 500k commands/mo); $0.20 per 100k commands after",
    billingUrl: "https://console.upstash.com/",
    docsUrl: "https://upstash.com/pricing",
  },

  // AI / ASR / TTS
  {
    key: "anthropic_api",
    name: "Anthropic (Claude)",
    category: "ai",
    currency: "USD",
    purpose: "AI class-content, summaries, insights, and briefs.",
    pricingModel: {
      kind: "payg",
      metric: "ai_generations",
      unit: "generation",
      ratePerUnit: 5,
      currency: "USD",
    },
    billingModel:
      "Pay-as-you-go per token (Haiku 4.5 default, $1/$5 per MTok). ~$0.05/generation avg; COST_PLAYBOOK worst case ~$0.15/gen (max_tokens 4096), capped ~100/mo per teacher.",
    billingUrl: "https://console.anthropic.com/settings/billing",
    docsUrl: "https://www.anthropic.com/pricing",
  },
  {
    key: "claude_code",
    name: "Claude Code",
    category: "ai",
    currency: "USD",
    purpose: "Developer coding assistant.",
    pricingModel: { kind: "monthly", amountMinor: 2000, currency: "USD" },
    billingModel: "Claude subscription (~$20/mo Pro; Max tiers $100–200/mo)",
    docsUrl: "https://www.anthropic.com/pricing",
  },
  {
    key: "deepgram",
    name: "Deepgram",
    category: "ai",
    currency: "USD",
    purpose: "Speech-to-text for lesson audio (the only wired ASR adapter today).",
    pricingModel: {
      kind: "payg",
      metric: "video_minutes",
      unit: "minute",
      ratePerUnit: 0.43,
      currency: "USD",
    },
    billingModel:
      "$0.0043/min (Nova-3 batch); $200 one-time free credit (NOT a monthly allowance). Driven by LessonAudio minutes.",
    billingUrl: "https://console.deepgram.com/",
    docsUrl: "https://deepgram.com/pricing",
  },
  {
    key: "assemblyai",
    name: "AssemblyAI",
    category: "ai",
    currency: "USD",
    purpose: "Alternate speech-to-text — configured but has no adapter yet (no live usage).",
    pricingModel: {
      kind: "payg",
      metric: "video_minutes",
      unit: "minute",
      ratePerUnit: 0.25,
      currency: "USD",
    },
    billingModel:
      "$0.15/hr (~$0.0025/min, Universal batch); $50 one-time credit. Aspirational — no adapter wired.",
    billingUrl: "https://www.assemblyai.com/app",
    docsUrl: "https://www.assemblyai.com/pricing",
  },
  {
    key: "azure_speech",
    name: "Azure Speech",
    category: "ai",
    currency: "USD",
    purpose: "Pronunciation scoring (LessonPronunciation).",
    pricingModel: {
      kind: "payg",
      metric: "video_minutes",
      unit: "audio-minute",
      ratePerUnit: 1.67,
      includedUnits: 300,
      currency: "USD",
    },
    billingModel: "$1/audio-hour STT (~$0.0167/min); 5 audio-hours/mo free (F0 tier)",
    billingUrl: "https://portal.azure.com/",
    docsUrl: "https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/",
  },
  {
    key: "google_tts",
    name: "Google Text-to-Speech",
    category: "ai",
    currency: "USD",
    purpose: "Fallback text-to-speech for material podcasts (behind ElevenLabs).",
    pricingModel: { kind: "free" },
    billingModel:
      "$4 per 1M chars (Standard) with 4,000,000 chars/mo free — effectively $0 at current volume. Modelled free to avoid double-counting the ai_generations meter with Anthropic.",
    billingUrl: "https://console.cloud.google.com/billing",
    docsUrl: "https://cloud.google.com/text-to-speech/pricing",
  },
  {
    key: "elevenlabs",
    name: "ElevenLabs",
    category: "ai",
    currency: "USD",
    purpose: "Primary high-quality TTS voices for material podcasts.",
    pricingModel: { kind: "monthly", amountMinor: 600, currency: "USD" },
    billingModel:
      "Starter ~$6/mo (30k credits); Creator $22/mo (100k) if podcasting regularly. Free tier (10k credits/mo) is non-commercial.",
    billingUrl: "https://elevenlabs.io/app/subscription",
    docsUrl: "https://elevenlabs.io/pricing",
  },

  // Video / real-time
  {
    key: "livekit",
    name: "LiveKit",
    category: "video",
    currency: "USD",
    purpose: "In-lesson video calls.",
    pricingModel: { kind: "free", freeTier: { metric: "video_minutes", allowance: 5000 } },
    billingModel:
      "Build (free): 5,000 connection-min + 1,000 agent-min/mo (hard cap, no overage); Ship $50/mo above; egress ~$0.10/GB. Driven by class-call participant-minutes.",
    billingUrl: "https://cloud.livekit.io/",
    docsUrl: "https://livekit.io/pricing",
  },

  // Email / notifications
  {
    key: "amazon_ses",
    name: "Amazon SES",
    category: "email",
    currency: "USD",
    purpose: "Transactional email — the preferred rail (EMAIL_PROVIDER prefers SES over Resend).",
    pricingModel: {
      kind: "payg",
      metric: "emails",
      unit: "email",
      ratePerUnit: 0.01,
      currency: "USD",
    },
    billingModel:
      "$0.10 per 1,000 emails (~$0.0001/email), metered, no monthly floor. Alternate rail with Resend — only one is active; deactivate the unused one.",
    billingUrl: "https://console.aws.amazon.com/billing/",
    docsUrl: "https://aws.amazon.com/ses/pricing/",
  },
  {
    key: "resend",
    name: "Resend",
    category: "email",
    currency: "USD",
    purpose: "Transactional email — fallback rail behind SES.",
    pricingModel: {
      kind: "payg",
      metric: "emails",
      unit: "email",
      ratePerUnit: 0.1,
      includedUnits: 3000,
      currency: "USD",
    },
    billingModel:
      "3,000/mo free (100/day); Pro $20/mo = 50k; ~$0.001/email over. Alternate rail with SES — only one active at a time.",
    billingUrl: "https://resend.com/settings/billing",
    docsUrl: "https://resend.com/pricing",
  },

  // Analytics / monitoring
  {
    key: "posthog",
    name: "PostHog",
    category: "analytics",
    currency: "USD",
    purpose: "Product analytics (behavioral; never the money-of-record).",
    pricingModel: { kind: "free" },
    billingModel: "Free (1M events/mo, 5k session replays/mo)",
    billingUrl: "https://us.posthog.com/organization/billing",
    docsUrl: "https://posthog.com/pricing",
  },
  {
    key: "sentry",
    name: "Sentry",
    category: "monitoring",
    currency: "USD",
    purpose: "Error and performance monitoring.",
    pricingModel: { kind: "free" },
    billingModel: "Developer (free): 5k errors/mo, 10k spans; Team $26/mo above",
    billingUrl: "https://sentry.io/settings/billing/",
    docsUrl: "https://sentry.io/pricing/",
  },
  {
    key: "uptimerobot",
    name: "UptimeRobot",
    category: "monitoring",
    currency: "USD",
    purpose: "Uptime monitoring.",
    pricingModel: { kind: "free" },
    billingModel:
      "Free (50 monitors, 5-min interval) — non-commercial since Oct 2024; Solo $9/mo for commercial use",
    docsUrl: "https://uptimerobot.com/pricing/",
  },

  // Auth / payments / calendar
  {
    key: "better_auth",
    name: "better-auth",
    category: "authentication",
    currency: "USD",
    purpose: "Authentication (self-hosted open-source library).",
    pricingModel: { kind: "free" },
    billingModel: "Open-source MIT library (no vendor fee; you pay only the DB/compute it runs on)",
    docsUrl: "https://www.better-auth.com/",
  },
  {
    key: "stripe",
    name: "Stripe",
    category: "payments",
    currency: "USD",
    purpose: "Card payments + Connect payouts + subscription billing.",
    pricingModel: { kind: "free" },
    billingModel:
      "No platform subscription; per-transaction fees are netted in the payments ledger, not modeled here",
    billingUrl: "https://dashboard.stripe.com/billing",
    docsUrl: "https://stripe.com/pricing",
  },
  {
    key: "wise",
    name: "Wise",
    category: "payments",
    currency: "USD",
    purpose: "Parallel payout rail (manual teacher confirmation).",
    pricingModel: { kind: "free" },
    billingModel: "No platform subscription (per-transfer fees borne at transfer time)",
    docsUrl: "https://wise.com/pricing/",
  },
  {
    key: "google_calendar",
    name: "Google Calendar",
    category: "other",
    currency: "USD",
    purpose: "Two-way calendar sync for teachers.",
    pricingModel: { kind: "free" },
    billingModel: "Free API (quota-limited)",
    docsUrl: "https://developers.google.com/calendar",
  },

  // Dev tooling
  {
    key: "github_actions",
    name: "GitHub Actions",
    category: "dev_tools",
    currency: "USD",
    purpose: "CI/CD (GitHub-hosted runners, D-157).",
    pricingModel: { kind: "free" },
    billingModel:
      "Free on a public repository; 2,000 Linux-min/mo then $0.008/min if it ever goes private again (D-157).",
    billingUrl: "https://github.com/settings/billing",
    docsUrl: "https://docs.github.com/billing/managing-billing-for-github-actions",
  },
  {
    key: "inngest",
    name: "Inngest",
    category: "dev_tools",
    currency: "USD",
    purpose: "Background jobs and cron.",
    pricingModel: { kind: "free" },
    billingModel: "Hobby (free): 50k executions/mo; Pro $75/mo above",
    billingUrl: "https://app.inngest.com/billing",
    docsUrl: "https://www.inngest.com/pricing",
  },

  // Domain
  {
    key: "domain_registrar",
    name: "Domain registrar",
    category: "other",
    currency: "USD",
    purpose: "spiralclass.com domain registration.",
    pricingModel: { kind: "annual", amountMinor: 803, currency: "USD" },
    billingModel: "~$8/year (Cloudflare Registrar, at-cost; Namecheap ~$18/yr)",
  },
] as const;
