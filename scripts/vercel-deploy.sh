#!/usr/bin/env bash
# The SECOND production target. Fly is the first one and is unchanged.
#
# [D-175] reversed the half of [D-89] Phase 5 that tore the Vercel project down,
# and reversed nothing else: the TARGET comes back, the COUPLING does not. There
# is still no `VERCEL_ENV` branch in `apps/web/src`, still no `@vercel/*`
# dependency, and still no `vercel.json` at the repo root — which is what
# `apps/web/tests/config/decommissioned-platforms.test.ts` goes on asserting.
# Everything Vercel-shaped about this deploy lives in this file and in
# `config/vercel/<env>.json`, where a reader looking for the deploy will find it.
#
# ⚠️ WHAT THIS DELIBERATELY DOES NOT DO, which is most of what fly-deploy.sh
# does. Read this before adding any of it back, because each omission is load
# bearing and two of them are hazards rather than savings.
#
#   * NO Neon checkpoint (D-95) and NO migrations. Fly's deploy already ran
#     both, against the same Neon `production` branch, for the same commit —
#     `deploy-production.yml` runs this AFTER that job, `needs:` it, and the
#     database work is therefore already done and done once. Cutting a second
#     checkpoint is merely noisy. Running `migrate-regions.ts` a second time is
#     worse: Prisma takes an advisory lock, so a concurrent run would block
#     rather than corrupt, but a SEQUENTIAL second run against an
#     already-migrated branch is a no-op that makes this script look like it
#     owns the schema. It does not. One commit, one migration run, in the job
#     that checkpoints first.
#   * NO Inngest sync, and this is the sharp one. `scripts/inngest-sync.sh`
#     PUTs an endpoint URL, and Inngest registers an app PER URL. Syncing a
#     second URL would register a second app — so a cron defined once would be
#     registered twice and FIRE TWICE, once from Fly and once from a failover
#     that is not serving traffic. The 2026-07-07 email+push outage was a cron
#     that silently never ran; this is the same class of failure pointing the
#     other way, and it would bill real Stripe customers twice. The Inngest
#     endpoint belongs to whichever deployment holds the domain, which is Fly.
#   * NO production probes. `scripts/local/synthetic.sh` probes
#     https://spiralclass.com, which this deploy does not serve (see
#     --skip-domain below). Pointing it at the Vercel deployment URL would be a
#     second definition of "is production healthy".
#
# So the ordered steps here are four, not seven:
#
#   1. resolve the build-time NEXT_PUBLIC_* values from the SAME source the
#      Docker build reads — config/env/<env>.build.env, through
#      scripts/env-build-args.mjs
#   2. `vercel build` them into .vercel/output
#   3. `vercel deploy --prebuilt --skip-domain` — a production deployment that
#      does NOT take the domain
#   4. record the deploy in the local release ledger
#
# WHY --skip-domain, AND WHY IT IS NOT A TIMID DEFAULT. This target exists as a
# warm failover: D-150's second addendum settled that production serves from Fly
# `ord`, and nothing here changes that. `vercel deploy --prod` would assign
# spiralclass.com on every run, which is a DNS-level cutover performed by a CI
# job — exactly the class of thing CLAUDE.md's first rule reserves to the
# operator. `--skip-domain` builds and deploys the real production artifact and
# leaves the alias alone, so the failover is PROVEN on every release rather than
# being a dormant project nobody has deployed since it was set up. That is
# D-164's lesson applied rather than restated: infrastructure that is never
# exercised stops describing anything.
#
# Taking the domain is then one deliberate operator command against a deployment
# that is already live and already warm:
#
#   npx --yes vercel@59.15.1 promote <deployment-url> --yes
#
# WHY THE BUILD VALUES ARE WRITTEN OVER WHAT `vercel pull` BRINGS DOWN.
# `vercel pull` writes the Vercel project's own env vars to
# .vercel/.env.production.local, and `vercel build` reads that file. Left alone,
# that makes the Vercel dashboard a SECOND source of truth for values that are
# baked irreversibly into the client bundle — the exact drift
# scripts/env-build-args.mjs exists to prevent for the Docker build (see its
# header). So step 1 appends this repository's values after the pulled ones,
# last-wins, and config/env/<env>.build.env stays the only place they are
# stated. resolveEnvFile throws naming every unsatisfied __LOCAL__, so a
# misconfigured caller fails here rather than shipping a broken Stripe key to
# real browsers.
#
# WHY NO `output: "standalone"`. next.config.ts sets it only when
# BUILD_STANDALONE=1, which the Dockerfile sets and this script does not. The
# app was already provider-neutral — D-150 claimed that and this is the first
# thing to test the claim.
#
# CREDENTIALS. Three values, and the Vercel CLI reads all three natively from
# the environment, so this script branches on none of them:
#
#   VERCEL_TOKEN       authenticates the CLI
#   VERCEL_ORG_ID      } stand in for `vercel link`, which would write a
#   VERCEL_PROJECT_ID  } .vercel/project.json this repository does not commit
#
# Same arrangement as Fly's: Infisical is the source of truth and PUSHES them
# into the `production` GitHub Environment ([D-163]), so the job holds exactly
# what it needs and no identity that could ask for more. From a laptop:
#
#   infra/infisical/run.sh production scripts/vercel-deploy.sh production \
#     --yes-i-understand-this-skips-the-promote-gate
#
# ⚠️ These three are the ONLY VERCEL_* names this repository sets, and they are
# deploy-time credentials rather than runtime config. Nothing in apps/web reads
# them, and nothing should: prod-vs-preview is decided by APP_URL
# (isProductionDeployment(), sentryEnvironment(), the CSP), which is why this
# target needed no application change at all.
#
# Requires: node, npx, git. No Docker, no flyctl — the build happens in Vercel's
# builder, which is the one genuine simplification over the Fly path.
#
# Usage:
#   ./scripts/vercel-deploy.sh production --gate-already-passed                        # what deploy-production.yml calls
#   ./scripts/vercel-deploy.sh production --yes-i-understand-this-skips-the-promote-gate

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Pinned, for the same reason every action in .github/workflows is pinned to a
# SHA: a deploy whose tool floats is a deploy that can change without a commit.
# `neonctl@latest` in infra/database/scripts/ is the older convention and the
# weaker one — this is a tool that uploads a production artifact.
#
# ⚠️ Bump deliberately, and read the CLI's changelog for `build`/`deploy`
# behaviour when you do. Verified 2026-09-10: 59.15.1 was `npm view vercel
# version`, and it is the version every flag below was checked against.
VERCEL_CLI_VERSION="${VERCEL_CLI_VERSION:-59.15.1}"
VERCEL=(npx --yes "vercel@${VERCEL_CLI_VERSION}")

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
production)
  # The same two doors fly-deploy.sh opens, and for the same reason. There is no
  # `preview` case yet on purpose: D-175 added ONE target, and preview's is
  # still the Oracle box D-150's addendum assigned it. Adding preview here means
  # adding config/vercel/preview.json and a decision about what serves
  # preview.spiralclass.com — not defaulting into it.
  if [ "${2:-}" != "--gate-already-passed" ] &&
    [ "${2:-}" != "--yes-i-understand-this-skips-the-promote-gate" ]; then
    echo "Refusing to deploy production from a local script without the full promote gate (checks + integration + E2E)." >&2
    echo "Normal path: pnpm promote — it runs the gate, fast-forwards production, and deploy-production.yml calls this for you." >&2
    echo "If you really mean to bypass that here, re-run with: production --yes-i-understand-this-skips-the-promote-gate" >&2
    exit 1
  fi
  ;;
*)
  echo "usage: $0 production [--gate-already-passed|--yes-i-understand-this-skips-the-promote-gate]" >&2
  exit 1
  ;;
esac

CONFIG="config/vercel/${ENVIRONMENT}.json"
[ -f "$CONFIG" ] || {
  echo "vercel-deploy: $CONFIG is missing — it carries the framework, the monorepo build commands and the function region." >&2
  exit 1
}

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v npx >/dev/null || { echo "npx is required (it fetches the pinned Vercel CLI)" >&2; exit 1; }

# An ABSENT GitHub secret is the empty string, silently — the same trap
# deploy-production.yml's preflight step exists for. Check all three here too,
# because this script is also run by hand, and a half-configured laptop run
# would otherwise fail inside the CLI with a message about project linking.
MISSING=""
[ -n "${VERCEL_TOKEN:-}" ] || MISSING="$MISSING VERCEL_TOKEN"
[ -n "${VERCEL_ORG_ID:-}" ] || MISSING="$MISSING VERCEL_ORG_ID"
[ -n "${VERCEL_PROJECT_ID:-}" ] || MISSING="$MISSING VERCEL_PROJECT_ID"
if [ -n "$MISSING" ]; then
  echo "vercel-deploy: missing$MISSING" >&2
  echo "" >&2
  echo "  Infisical's \`${ENVIRONMENT}\` environment is the source of truth (D-163) and syncs" >&2
  echo "  them into the GitHub Environment of the same name. From a laptop, compose:" >&2
  echo "    infra/infisical/run.sh ${ENVIRONMENT} scripts/vercel-deploy.sh ${ENVIRONMENT} --gate-already-passed" >&2
  exit 1
fi
# Exported, never passed as `--token=…`. The CLI reads all three natively, and
# a credential on the command line is readable by any process on the box through
# `ps` — including, on a runner, whatever `pnpm install` just executed. Same
# reasoning as `flyctl`'s FLY_API_TOKEN in scripts/fly-deploy.sh, which is also
# never passed as a flag.
export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID

SHA="$(git rev-parse HEAD)"

# ── 1. Build-time config, from the one place it is stated ────────────────
# Pull first so the project's settings and env land in .vercel/, then append
# this repository's values so they win. --yes because the prompt it suppresses
# is "pull settings?", and that is the whole reason we called it.
echo "› Pulling ${ENVIRONMENT} project settings from Vercel…"
"${VERCEL[@]}" pull --yes --environment="$ENVIRONMENT"

# ⚠️ DISCOVERED, NOT ASSUMED. `vercel pull` writes the project's env into
# `.vercel/`, and the CLI's own documentation does not pin the filename —
# `.env.production.local` is convention, not a contract, and it has moved
# before. Hardcoding it would fail in the worst available way: the append would
# create a file the builder ignores, the build would go green, and the DASHBOARD
# values would ship to real browsers. That is precisely the drift this overlay
# exists to prevent, reached by trusting a path instead of checking it.
#
# So: find what the pull actually wrote, require exactly one candidate, and
# refuse otherwise. A deploy that cannot prove where its build values come from
# has no business baking them irreversibly into a client bundle.
# `while read` rather than `mapfile`: macOS still ships bash 3.2 as /bin/bash,
# and this script is meant to be runnable from the operator's laptop as well as
# from a runner. A bash-4 builtin here would fail at the one moment someone is
# deploying by hand.
ENV_FILE=""
ENV_FOUND=""
ENV_COUNT=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  ENV_FILE="$candidate"
  ENV_FOUND="${ENV_FOUND}    ${candidate}
"
  ENV_COUNT=$((ENV_COUNT + 1))
done < <(find .vercel -maxdepth 1 -name '.env*' -type f 2>/dev/null | sort)

if [ "$ENV_COUNT" -ne 1 ]; then
  echo "" >&2
  echo "  vercel-deploy: expected exactly one env file under .vercel/ after \`vercel pull\`," >&2
  echo "  found ${ENV_COUNT}:" >&2
  [ -z "$ENV_FOUND" ] || printf '%s' "$ENV_FOUND" >&2
  echo "" >&2
  echo "  Refusing to continue. The overlay below is what keeps" >&2
  echo "  config/env/${ENVIRONMENT}.build.env the single source of truth for values that" >&2
  echo "  are baked IRREVERSIBLY into the client bundle (D-175). Appending to the wrong" >&2
  echo "  file would ship the Vercel dashboard's copy instead, with nothing failing." >&2
  echo "" >&2
  echo "  If the CLI changed where it writes, fix this discovery — do not hardcode a name." >&2
  exit 1
fi
echo "› Overlaying NEXT_PUBLIC_* from config/env/${ENVIRONMENT}.build.env onto ${ENV_FILE} (last wins)…"
# Same invocation the Docker build uses, same throw on an unsatisfied __LOCAL__.
# The sed strips env-build-args.mjs's GITHUB_OUTPUT heredoc wrapper, exactly as
# scripts/fly-deploy.sh does — kept byte-identical so the two callers cannot
# disagree about the format.
BUILD_ARGS_OUT="$(node scripts/env-build-args.mjs "$ENVIRONMENT")"
BUILD_ARGS_BLOCK="$(echo "$BUILD_ARGS_OUT" | sed -n '/^build_args<</,/^__FLY_BUILD_ARGS_EOF__$/p' | sed '1d;$d')"

{
  echo ""
  echo "$BUILD_ARGS_BLOCK"
  # The per-deploy identifier for Next's `?dpl=` version-skew mitigation, set
  # exactly as scripts/fly-deploy.sh sets it: the commit being deployed. Both
  # targets stamping the SAME id for the same commit is the point — a client
  # that was served by Fly and is then served by Vercel after a promote must
  # not see a skew it has to hard-navigate through.
  echo "NEXT_DEPLOYMENT_ID=${SHA}"
} >>"$ENV_FILE"

# ── 2. Build ─────────────────────────────────────────────────────────────
# --prod, not --target=production: the flag that selects PRODUCTION
# environment variables for the build. The domain question is settled at deploy
# time, below, and these two are independent despite the shared word.
echo "› Building ${SHA} for ${ENVIRONMENT} (no BUILD_STANDALONE — this is Vercel's builder, not the Dockerfile)…"
"${VERCEL[@]}" build --prod --yes --local-config "$CONFIG"

# ── 3. Deploy, WITHOUT taking the domain ─────────────────────────────────
# See the header. --skip-domain is the difference between a proven failover and
# a CI job performing a DNS cutover nobody asked for.
echo "› Deploying the prebuilt output (--skip-domain: spiralclass.com stays on Fly)…"
DEPLOYMENT_URL="$("${VERCEL[@]}" deploy --prebuilt --prod --skip-domain --local-config "$CONFIG")"

echo "› Deployed: ${DEPLOYMENT_URL}"

# ── 4. Release ledger ────────────────────────────────────────────────────
# A distinct kind, so `pnpm release:status` cannot read a warm failover as the
# thing serving spiralclass.com. record-release.mjs takes --kind as a free
# string; the Fly deploy records `web-deploy`.
echo "› Recording the deploy in the release ledger…"
node scripts/ci/record-release.mjs --kind web-deploy-vercel --env "$ENVIRONMENT" --sha "$SHA" || true

echo ""
echo "Vercel ${ENVIRONMENT} is warm at ${DEPLOYMENT_URL}, and serves no traffic."
echo "To hand it the domain — an operator decision, not this script's:"
echo "  npx --yes vercel@${VERCEL_CLI_VERSION} promote ${DEPLOYMENT_URL} --yes"
