# Self-hosted deploy for the LiveKit captions Agent
# — a small always-on worker
# that runs alongside livekit-server on the self-hosted Oracle box
# (the Oracle box — see docs/deployment/ORACLE_BOX_REBUILD.md; the
# infra/oracle-runner module was deleted 2026-08-29, D-139).
# NOT part of the Fly build/deploy pipeline (that's
# the root ./Dockerfile, apps/web only).
#
# Build from the REPO ROOT (this package depends on pnpm-workspace.yaml +
# packages/shared, same monorepo-manifests-first pattern as the root
# Dockerfile).
#
# HOW THIS ACTUALLY SHIPS TODAY (D-108): the box HAS a real checkout at
# ~/agendaprofe (a `main` branch pushed to it over Tailscale), and the
# image is BUILT THERE and tagged with the commit SHA — it is not pulled from
# a registry. Nothing has ever published a GHCR image for this package.
#
# THE PATH AND THE IMAGE NAME ARE THE PRE-RENAME ONES, ON PURPOSE. The repo
# was renamed agendaprofe -> spiralclass; the box's directory and image tag
# were not renamed with it, and the compose file's `build.context` and
# `image:` both still say `agendaprofe`. This comment said `~/spiralclass`
# and `spiralclass-captions-agent:$SHA` for a while, which are a directory
# that does not exist and an image the compose file would ignore. Verified
# against the live box 2026-09-02. Do not "correct" these back without
# renaming on the box first:
#
#   cd ~/agendaprofe && SHA=$(git rev-parse --short HEAD)
#   docker build -f packages/livekit-captions-agent/Dockerfile \
#     -t agendaprofe-captions-agent:$SHA -t agendaprofe-captions-agent:latest .
#
# Full deploy/rollback/live-call-interlock procedure:
# docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md §"Captions Agent — deploy &
# rollback". Restarting this container kills captions for any class in
# progress — check the interlock before deploying.
#
# THE INTENDED END STATE (not built yet) is a CI-built arm64 image pushed to
# GHCR and pulled by tag, which is what the deleted infra/oracle-runner/services/
# docker-compose.livekit.yml.tftpl's `image:` line already declares. Until
# that exists, the template's line is aspirational and the box's own compose
# carries a `build:` context instead. See
# the captions-agent delivery design.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS builder
# Manifests only, so this layer is a cache-hit unless a package.json/lockfile
# changes — pnpm still needs every workspace package's manifest to resolve
# pnpm-lock.yaml even when --filter narrows what actually gets installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/livekit-captions-agent/package.json ./packages/livekit-captions-agent/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter=@spiralclass/livekit-captions-agent...

# Now bring in the real source — lands after install so a code-only change
# never re-runs it.
COPY packages/shared ./packages/shared
COPY packages/livekit-captions-agent ./packages/livekit-captions-agent

FROM base AS runner
ENV NODE_ENV=production
ENV TZ=UTC
RUN groupadd --system --gid 1001 agent \
  && useradd --system --uid 1001 --gid agent agent
COPY --from=builder --chown=agent:agent /repo/node_modules ./node_modules
COPY --from=builder --chown=agent:agent /repo/packages ./packages
WORKDIR /repo/packages/livekit-captions-agent
USER agent
# tsx directly, no separate build/dist step — same convention this repo
# already uses for packages/livekit-activity-cli's own standalone runtime.
CMD ["/repo/node_modules/.bin/tsx", "src/index.ts"]
