# Production build for apps/web — this image IS what Fly runs, in both
# environments (D-89). It began as a Fly spike alongside Vercel; Vercel and
# Supabase were decommissioned in D-89 Phase 5, so there is no second build
# path left to stay compatible with.

# PINNED (M-7). `node:24-slim` is a MUTABLE tag: the digest it resolves to moves
# over time, so an unpinned rebuild can silently pull a different — potentially
# tampered — base image. The digest below is the multi-platform OCI index, so it
# covers linux/amd64 (what Fly runs, and what a native CI runner builds) and
# linux/arm64 (the laptop) from one line.
#
# To move it, deliberately:
#   docker buildx imagetools inspect node:24-slim     # read `Digest:`
# then replace the digest here and rebuild. Renovate/Dependabot will not do it
# for you — `docker` is not in dependabot.yml's ecosystems.
#
# Node major pinned to >=24.15.0 (not just "latest 24"): fixes a Node core
# TransformStream race (nodejs/node#62036/#62040) that throws
# "controller[kState].transformAlgorithm is not a function" when a client
# disconnects mid-SSR-stream (e.g. a mobile browser navigating away while
# `/dashboard/materials` is still streaming). Never backported to the 22.x
# LTS line — see Sentry SPIRALCLASS-2W. Don't downgrade this back to 22.
FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239 AS base
# Prisma's engine postinstall probes libssl to pick the right query-engine
# binary; node:24-slim doesn't ship it, so without this it silently guesses
# openssl-1.1.x, which can mismatch the engine actually bundled and fail at
# runtime rather than at build time.
RUN apt-get update -qq && apt-get install --no-install-recommends -y openssl \
  && rm -rf /var/lib/apt/lists /var/cache/apt/archives
RUN corepack enable
WORKDIR /repo

FROM base AS builder
# Debian (not Alpine) so sharp and Prisma's native engines — both allow-listed
# in root pnpm-workspace.yaml's allowBuilds — get prebuilt glibc binaries
# instead of needing a musl rebuild.

# Manifests only, so this layer (and the install below) is cache-hit on every
# deploy that doesn't touch a package.json/lockfile — pnpm still needs every
# workspace package's manifest to resolve pnpm-lock.yaml even when --filter
# narrows what actually gets installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
# apps/web's postinstall runs `prisma generate`, which needs the schema
# present at install time — copied here (not with the rest of source below)
# so a schema-only change still invalidates this layer correctly, and a
# non-schema code change still doesn't.
COPY apps/web/prisma ./apps/web/prisma
# --filter=spiralclass-web... installs only web's own + upstream workspace
# deps (packages/shared), skipping the CLI packages web does not import.
# Cache mount persists the pnpm content-addressable store
# across deploys (Depot keeps build cache warm), so even a lockfile change
# only re-fetches the packages that actually changed.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter=spiralclass-web...

# Now bring in the real source — this is the layer that invalidates on every
# code change, but it lands AFTER install, so a code-only push never re-runs it.
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUILD_STANDALONE=1
# Next's build-time "Collecting page data" step statically imports every
# route module, and something in that import chain calls serverEnv() (Zod-
# validated) at module load — even though nothing at build time actually
# connects to the DB. `fly secrets set` only
# reaches the RUNNING container, not this build step, so these are
# placeholder SHAPES only, satisfying Zod's format checks — real values
# from `fly secrets` override them at runtime (container env always wins
# over an image's baked-in ENV default).
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    DIRECT_URL="postgresql://build:build@localhost:5432/build" \
    SESSION_SECRET="build-time-placeholder-not-a-real-secret"
# UNLIKE the server vars above, NEXT_PUBLIC_* vars are inlined into the
# CLIENT bundle by webpack AT BUILD TIME — a placeholder here bakes wrong
# values permanently into shipped JS, regardless of runtime fly secrets.
# None of the nine below are sensitive (the Sentry DSN, the PostHog client
# key and the Stripe publishable key are all public-by-design — they ship in
# every site's client JS; the R2/WhatsApp values are plain public URLs/phone
# numbers — see infra/cloudflare-r2/README.md's "public URL is manual" note,
# D-66), so pass the real ones as build args. They are sourced from
# config/env/<env>.build.env (D-85) by scripts/env-build-args.mjs, which the
# build+deploy path (scripts/fly-deploy.sh, which the workflows call — D-157)
# turns into `--build-arg NAME=...` flags — see config/env/README.md:
ARG NEXT_PUBLIC_DEPLOY_ENV
ARG NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL
ARG NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL
ARG NEXT_PUBLIC_SUPPORT_WHATSAPP
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_REGION
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_DEPLOY_ENV=${NEXT_PUBLIC_DEPLOY_ENV} \
    NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL=${NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL} \
    NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL=${NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL} \
    NEXT_PUBLIC_SUPPORT_WHATSAPP=${NEXT_PUBLIC_SUPPORT_WHATSAPP} \
    NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN} \
    NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
    NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST} \
    NEXT_PUBLIC_POSTHOG_REGION=${NEXT_PUBLIC_POSTHOG_REGION} \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}
# The per-deploy identifier Next stamps on asset/chunk/server-action requests
# as `?dpl=<id>`, so a client left on an old build stops silently pulling chunks
# the new deploy renamed and gets a hard navigation instead. next.config.ts has
# read NEXT_DEPLOYMENT_ID since it was written and told the reader to "set it to
# the commit SHA on the Fly build" — nothing ever did, in the Dockerfile, in
# scripts/fly-deploy.sh or in config/env/<env>.build.env, so `deploymentId` was
# `undefined` on every image ever shipped and the mitigation was inert. That is
# half of why AGENDAPROFE-3B reached a real visitor. scripts/fly-deploy.sh
# passes `--build-arg NEXT_DEPLOYMENT_ID=$SHA` (the commit being deployed) to
# both of its buildx invocations; unset, Next falls back to its build-time
# default exactly as before, so a local `docker build` still works.
#
# It sits AFTER the install layer deliberately: the value changes every deploy,
# and invalidating from here down costs nothing, because `COPY . .` above
# already invalidates on every code change.
ARG NEXT_DEPLOYMENT_ID
ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}
# Build with Turbopack (Next's Rust bundler) — NOT the default webpack build.
# Measured: ~3.45GB peak, compile ~70-80s, vs webpack's ~5-6GB and
# single-threaded ~12min. This image builds with Turbopack via its own
# `build:standalone` script (apps/web/package.json); `pnpm build` keeps the
# webpack path for the gate's local/CI build check.
#
# WHERE THIS BUILDS: on a GitHub-hosted `ubuntu-latest` runner (16GB, genuine
# amd64), via scripts/fly-deploy.sh — D-157. It used to build on Fly's free
# bundled Depot builder, a fixed ~4GB container: peak ~3.45GB + ~0.3GB
# parent/pnpm left ~230MB of slack, which is a coin flip rather than a tuned
# build — measured on run 29432718708, two Depot attempts of one commit peaked
# 2MB apart and one died, one lived. It went red on 2026-07-15. Read
# scripts/fly-deploy.sh's header before moving the build anywhere: Fly needs
# amd64, which is why this laptop's arm64 cross-build takes 20-30+ minutes.
#
# MEASURED (run 29432718708, sampler below), do not re-theorise without data:
#   cap 3072 -> compile worker peaks ~3.5GB
#   cap 2048 -> compile worker peaks ~3.45GB   (~2GB V8 + ~1.4GB Rust native)
# Lowering the cap barely moves the peak, so V8 is NOT lazily ballooning to its
# cap — the ~1.4GB native half is bounded by nothing, and the JS half really is
# ~2GB. That is why no value here ever rescued the Depot build.
#
# The cap is 6144, not the old 2048. 2048 was chosen to be honest about what the
# build uses when every MB of Depot's 4GB mattered — but it sat right ON the JS
# half's ~2GB actual usage, one growth spurt from trading a cgroup SIGKILL
# (exit 137) for a V8 "JavaScript heap out of memory" (exit 134). With 16GB
# there is nothing to ration, so give V8 real headroom and let the cap be a
# backstop against a leak rather than a load-bearing constraint.
#
# This caps ONLY the V8 half of the compile process. `next build --turbopack`
# runs the compile in a forked worker (NEXT_TURBOPACK_USE_WORKER, on by
# default) that `turbopack-build/index.js` spawns with `isolatedMemory: false`,
# so it INHERITS this NODE_OPTIONS. Turbopack is a native Node addon, so that
# one process holds V8 heap + Rust allocations and only the former is bounded.
#
# Does NOT bound the static-generation workers: Next strips --max-old-space-size
# back out of those (`isolatedMemory: true`), so their count is capped via
# `experimental.cpus` in next.config.ts instead.
#
# `prisma generate` already ran in the install layer's postinstall, so the
# client is present without `build:standalone` re-running it.
ENV NODE_OPTIONS=--max-old-space-size=6144
# Invoke Next directly instead of `pnpm --filter spiralclass-web
# build:standalone`. Identical work — build:standalone IS `next build
# --turbopack` (apps/web/package.json) — but it skips the `pnpm run` wrapper,
# and that wrapper is not free here. pnpm 11 defaults verify-deps-before-run to
# `install`: once `COPY . .` above brings in the workspace manifests the
# filtered install layer deliberately never installed (the CLI packages),
# pnpm judges node_modules out of sync with the full workspace and
# silently runs a FULL install inside THIS layer — `Scope: all 6 workspace
# projects` / `Packages: -174`, ignoring --filter, re-running apps/web's
# prisma generate postinstall. That contradicts the layering this file already
# documents (see the `prisma generate already ran in the install layer's
# postinstall` note above) and is wasted work on every runner.
#
# On an arm64 host cross-building linux/amd64 it is worse than wasted: that
# implicit install finishes its work, prints `Done in Ns`, and then HANGS
# FOREVER in process teardown under emulation — 0 CPU ticks over 15s, 9 of 14
# threads parked in futex_wait_queue, no socket open. Reproduced three times.
# It is the same teardown path that aborts outright under QEMU (node's libuv
# hits a QEMU epoll bug, `uv__io_poll: Assertion errno == EEXIST failed`);
# Rosetta turns that abort into a deadlock. Not calling pnpm here removes the
# process that hangs, rather than working around the emulator.
#
# The lockfile stays authoritative: the install layer runs --frozen-lockfile,
# so real drift still fails the build there. nodeLinker is `hoisted`
# (pnpm-workspace.yaml), so next's bin resolves at the repo root.
# Sample memory while the build runs. This build has now been diagnosed blind
# twice; a cgroup SIGKILL prints nothing by itself, so without a running trail
# the next failure is another guess. `memory.peak`/`memory.current` are the
# exact numbers the kernel kills on, and the per-process RSS lines say WHICH
# process (parent / turbopack compile worker / static worker) grew. Costs one
# log line per 10s.
#
# Kept through the move off Depot so the first builds on the 16GB runner say
# out loud what the peak actually is there, rather than us assuming 4x headroom.
# Safe to delete once a few green runs confirm it — the number it exists to
# answer is no longer a live constraint, just a datapoint.
RUN --mount=type=cache,id=next-cache,target=/repo/apps/web/.next/cache \
    ( while :; do \
        printf '[mem] cgroup.current=%s cgroup.peak=%s cgroup.max=%s | top-rss:' \
          "$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo n/a)" \
          "$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo n/a)" \
          "$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo n/a)"; \
        for p in /proc/[0-9]*; do \
          r=$(sed -n 's/^VmRSS:[[:space:]]*\([0-9]*\).*/\1/p' "$p/status" 2>/dev/null); \
          [ -n "$r" ] && [ "$r" -gt 51200 ] && \
            printf ' %s=%sMB' "$(sed -n 's/^Name:[[:space:]]*//p' "$p/status" 2>/dev/null)" "$((r/1024))"; \
        done; \
        echo; \
        sleep 10; \
      done & MON=$!; \
      ( cd apps/web && ../../node_modules/.bin/next build --turbopack ); STATUS=$?; \
      kill "$MON" 2>/dev/null; \
      echo "[mem] final cgroup.peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo n/a) exit=$STATUS"; \
      exit $STATUS )

FROM base AS runner
# Re-declared because ARG does not cross stages. The running server needs the
# same id the build baked in — it is what `?dpl=` is validated against, and what
# /api/health reports as `commit`. A mismatch between the two halves would be
# worse than having neither.
ARG NEXT_DEPLOYMENT_ID
ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Pin explicitly rather than relying on the base image's default. The app's
# timezone architecture (UTC storage, IANA-aware conversion in lib/tz.ts) only
# holds if the process itself has no local-zone bias — a few call sites still
# use local-timezone Date getters (setMonth/getMonth) for non-instant math, and
# an unpinned TZ would make their behavior depend on the base image.
ENV TZ=UTC
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# next.config.ts's outputFileTracingRoot is the repo root, so the standalone
# output preserves the monorepo path (apps/web/server.js) rather than
# flattening to the package root — the two copies below must match that.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

# Non-secret RUNTIME config (D-85). The entrypoint sources the file matching
# APP_ENV (set in fly.<env>.toml) before starting the server, so these values
# no longer need to live in fly.<env>.toml's [env]. Both env files are baked in
# and APP_ENV selects one; the *.build.env half was already inlined at build.
COPY --from=builder --chown=nextjs:nodejs /repo/config/env/*.runtime.env ./config/env/
COPY --from=builder --chown=nextjs:nodejs /repo/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
# ENTRYPOINT sources config/env/$APP_ENV.runtime.env, then execs CMD.
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
