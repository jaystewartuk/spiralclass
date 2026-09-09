import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { buildSecurityHeaders } from "./src/lib/security-headers";

// Repo root, two levels up from apps/web/. Set as outputFileTracingRoot
// so Vercel's standalone bundling follows symlinks to workspace packages
// (e.g. @spiralclass/shared in packages/shared/) rather than treating
// them as missing modules. Without this, Next traces only from
// apps/web/ and can mis-handle the pnpm symlink layout.
const monorepoRoot = path.join(__dirname, "..", "..");

// Per-deploy identifier for Next.js's built-in version-skew mitigation: Next
// stamps `?dpl=<id>` on asset/chunk/server-action requests and, on a mismatch,
// forces a hard navigation instead of using a stale prefetch — so a client on
// an old build stops pulling chunks that the new deploy renamed.
//
// This is the FREE half of skew handling and is NOT full Skew Protection: it
// can't route a server-action POST back to the deployment that served the page
// (that needs Vercel Pro's deployment routing), so it does not by itself stop
// "Failed to find Server Action". The client reload fallback in
// src/lib/server-action-recovery.ts covers that residual case.
//
// Must change every deploy; a commit SHA does. Resolution order:
//   - NEXT_DEPLOYMENT_ID — the deploy identifier (Next reads this natively).
//     scripts/fly-deploy.sh passes the commit being deployed as a build arg and
//     the Dockerfile declares it in both stages, so the baked-in id and the
//     running server's agree. NOT in config/env/<env>.build.env, and it cannot
//     be: that file is static, and this value has to differ per deploy.
//     (It went unset from the day this was written until 2026-09-03, which made
//     everything below inert on every image ever shipped — see AGENDAPROFE-3B.
//     apps/web/tests/scripts/env-config.test.ts pins the wiring now, because
//     nothing else fails when it is missing.)
//   - undefined — Next falls back to its build-time default (dev / local).
// (Pre-D-89 this also read Vercel's VERCEL_GIT_COMMIT_SHA; Vercel is gone.)
const deploymentId = process.env.NEXT_DEPLOYMENT_ID || undefined;

const config: NextConfig = {
  reactStrictMode: true,
  deploymentId,
  outputFileTracingRoot: monorepoRoot,
  // Self-hosted Docker builds (Fly.io spike, docs/decisions/D-70.md) need a
  // self-contained server bundle. Vercel's own build system has its own
  // output format and doesn't need this, so it's opt-in via an explicit
  // build-time flag rather than always-on — zero effect on Vercel builds.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Teacher / testimonial profile photos are served from the public R2 bucket
  // (pub-*.r2.dev). Both entries below must be here or next/image rejects the
  // host and the optimizer 400s the photo.
  //
  // No Supabase entry: the Supabase project was torn down at the D-89 Phase 5
  // decommission, so a `*.supabase.co` remote pattern would only allow-list a
  // host that 404s everything now — removed as dead config (any stored photo
  // URL from before the R2 migration is already unreachable regardless of
  // what next/image allows).
  images: {
    remotePatterns: [
      // Public R2 buckets (teacher photos/videos) served via r2.dev domains.
      { protocol: "https", hostname: "*.r2.dev" },
      // PRIVATE R2 buckets (student profile photos) served via short-lived
      // SigV4-signed URLs against the S3 API endpoint —
      // <account_id>.r2.cloudflarestorage.com. Without this, next/image 400s
      // the signed URL and the photo never renders.
      { protocol: "https", hostname: "*.r2.cloudflarestorage.com" },
    ],
    // Next's default is 60s, which meant every optimized R2 photo was re-fetched
    // from R2 and re-run through sharp at least once a minute, per (src, w, q).
    // On the 512mb machine that was a recurring native-memory allocation with
    // nothing to show for it, and the source of the repeated `upstream image
    // response timed out` 504s during the 2026-08-26 outage (the optimizer's 7s
    // upstream timeout, against an R2 fetch competing with SSR for the event
    // loop). 31 days is safe HERE SPECIFICALLY because every public R2 URL
    // carries a `?v=` cache-buster (see lib/storage/r2-public-url.ts) — the
    // version changes the cache key, so a re-uploaded photo is a new key rather
    // than a stale hit. Do not raise this without that buster staying in place.
    minimumCacheTTL: 31 * 24 * 60 * 60,
    // Every distinct width is a separate sharp run AND a separate cache entry.
    // The app's optimized images are a 28/36px header avatar and a 320px
    // booking-page photo, so Next's default ladder (8 deviceSizes up to 3840px
    // + 8 imageSizes) generates variants nothing ever requests. Narrowing to the
    // sizes actually used cuts both the resize work and the cache footprint.
    deviceSizes: [640, 828, 1080, 1920],
    imageSizes: [32, 64, 96, 128, 256, 384],
  },
  // PostHog ingestion is proxied through our own origin (/ingest → US
  // cloud) so ad-blockers — which block requests to *.posthog.com by
  // hostname — don't silently drop client-side events and session
  // replays. Tradeoff: these become first-party requests we serve, so
  // they count against function invocations/bandwidth and can't be told
  // apart from app traffic in network logs. Server-side capture
  // (posthog-node, server-side analytics capture) is unaffected and remains the primary pipeline.
  //
  // Region is US by default (decision 2026-06-03 — closest to MX users).
  // The region is now config-driven (D-48): set NEXT_PUBLIC_POSTHOG_REGION=eu
  // to flip the proxy destinations below AND ui_host in posthog-provider.tsx
  // together (both read the same knob). The one-liner here mirrors
  // src/lib/analytics/posthog-region.ts — kept inline so next.config stays
  // free of app-code imports. A region flip still requires recreating the
  // PostHog project in the target cloud; this only aims the clients.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const region =
      process.env.NEXT_PUBLIC_POSTHOG_REGION?.trim().toLowerCase() === "eu" ? "eu" : "us";
    return [
      // Recorder + array bundles (static JS the SDK lazy-loads).
      {
        source: "/ingest/static/:path*",
        destination: `https://${region}-assets.i.posthog.com/static/:path*`,
      },
      // Event capture, /flags, /decide, and everything else.
      { source: "/ingest/:path*", destination: `https://${region}.i.posthog.com/:path*` },
    ];
  },
  experimental: {
    serverActions: {
      // Class-materials upload accepts up to 25 MB. Next.js
      // defaults server action bodies to 1 MB, which surfaces as a
      // generic "client-side exception" on uploads above that.
      // NOTE: Vercel Hobby caps function payloads at 4.5 MB regardless
      // of this setting; Pro caps at 50 MB. The hard 25 MB limit is
      // also enforced in the upload action itself.
      bodySizeLimit: "25mb",
    },
    // Trades some build wall-clock for materially lower peak memory during
    // webpack compilation. Added after a Vercel build OOM (SIGKILL, no
    // routes-manifest.json produced) — the app's route count has grown to
    // where a default-machine build sits close to the container's RAM
    // ceiling. Still applies to Vercel/production (webpack); the Fly build
    // now uses Turbopack (see Dockerfile), which ignores this flag.
    webpackMemoryOptimizations: true,
    // Fly/Depot only: cap the static-generation worker pool at 1.
    //
    // `experimental.cpus` is NOT a webpack-only knob and Turbopack does NOT
    // ignore it (#517 removed this cap on that premise, and the Fly build has
    // OOM'd on its first Depot attempt on every deploy since — surviving only
    // because flyctl silently retries the build). Only the *compile* is
    // Turbopack/Rust; `getNumberOfWorkers()` in next/dist/build/index.js is
    // bundler-agnostic and drives the Node worker pool that "Collecting page
    // data" / "Generating static pages" fork.
    //
    // Two container-unaware defaults collide on Depot's fixed ~4GB builder:
    // the pool defaults to `os.cpus().length - 1` — the BUILD HOST's core
    // count, not the container's share — and `createStaticWorker` passes
    // `isolatedMemory: true`, which strips the Dockerfile's
    // --max-old-space-size out of each child's NODE_OPTIONS, so every worker
    // sizes its V8 heap off the host's RAM too. N host-sized heaps plus
    // Turbopack's resident compile memory exceed the 4GB cgroup -> SIGKILL.
    // One worker is deterministic regardless of the host, and costs only a few
    // seconds (190 static pages).
    //
    // Vercel/production is unaffected: it builds via `pnpm build` with
    // BUILD_STANDALONE unset, keeping Next's default worker count.
    ...(process.env.BUILD_STANDALONE === "1" ? { cpus: 1 } : {}),
  },
  // Fly.io spike only: main-checks.yml already gates every PR merge on
  // `pnpm typecheck` + lint, so redoing both inside the Docker build is pure
  // duplicated work — this build showed ~106s just for "Linting and checking
  // validity of types". Trade-off: this build path loses that safety net if
  // a type/lint error somehow reached here despite the CI gate. Vercel's
  // build is unaffected (BUILD_STANDALONE unset there).
  ...(process.env.BUILD_STANDALONE === "1"
    ? {
        typescript: { ignoreBuildErrors: true },
        eslint: { ignoreDuringBuilds: true },
      }
    : {}),
  async redirects() {
    return [
      {
        // The pricing page lived at /precios — the one Spanish route slug in a
        // product whose UI is Spanish, English and French, left over from when
        // the product was Spanish-only. Renamed to /pricing so the URL matches
        // the rest of the site.
        //
        // PERMANENT, and this is the part that matters: /precios is a live
        // public URL. It is in the sitemap, it is linked from the footer and
        // the marketing header, and it has been shareable for months — some of
        // those links are in other people's messages and bookmarks. A rename
        // without a 308 turns every one of them into a 404, which is a worse
        // outcome than the inconsistent slug.
        source: "/precios",
        destination: "/pricing",
        permanent: true,
      },
    ];
  },

  async headers() {
    // NOTE: the Content-Security-Policy is NOT set here. It's nonce-based and
    // therefore per-request, so it's emitted from middleware (see
    // src/lib/csp.ts) where a fresh nonce is minted for each response. These
    // static headers apply to every route (including assets the CSP middleware
    // matcher skips) — see src/lib/security-headers.ts for the actual set and
    // why HSTS lives here explicitly rather than relying on the platform.
    //
    // `headers()` is evaluated at BUILD time, so this reads
    // NEXT_PUBLIC_DEPLOY_ENV — a build arg baked per environment from
    // config/env/<env>.build.env (preview→"preview", production→
    // "production"); local/CI builds leave it unset.
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders(process.env.NEXT_PUBLIC_DEPLOY_ENV),
      },
    ];
  },
};

// withSentryConfig wires the SDK's build-time plugin so the init
// modules (sentry.server.config + sentry.edge.config + the client
// instrumentation file) survive the prod bundle and Sentry's auto-
// instrumentation hooks attach. Without it, Sentry.init() runs but
// the runtime client ends up uninitialized in serverless deploys.
//
// `silent` keeps the build noise down; `disableLogger` strips the
// verbose console-log integration. Source-map upload stays opt-in
// (requires SENTRY_AUTH_TOKEN at build time) — without it the plugin
// just skips the upload step.
//
// Turbopack note (2026-07-14): the Fly/standalone build uses `next build
// --turbopack`. Sentry SDK v10 supports Turbopack — there's no webpack plugin
// pass, so the large build-time memory cost the webpack plugin used to add is
// gone, which is what lets the Fly build fit Fly's free ~4GB Depot builder.
// Kept unconditional (Vercel + Fly) so runtime Sentry stays wired on both.
export default withSentryConfig(config, {
  silent: !process.env.CI,
  disableLogger: true,
  // Tunnel browser-side Sentry events through our own origin (same idea as the
  // PostHog /ingest proxy above): ad/privacy blockers block requests to
  // *.sentry.io by hostname, silently dropping client error reports
  // (ERR_BLOCKED_BY_CLIENT). The SDK proxies them through this first-party path
  // and the generated route forwards to Sentry server-side, so blockers can't
  // see them. Same-origin, so the CSP connect-src 'self' already allows it.
  // (Server-side capture is unaffected and remains the primary pipeline.)
  tunnelRoute: "/monitoring",
});
