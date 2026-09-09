set shell := ["bash", "-uc"]
# Secrets come from Infisical, non-secret config from config/env/. There is no
# .env file to load, and auto-loading one would silently reintroduce exactly the
# per-machine state this repo removed — see tests/config/no-private-env-files.
set dotenv-load := false

# List every recipe, grouped and described (default when you just run `just`)
_default:
    @just --list --unsorted

# --- dev ---------------------------------------------------------------

# Launch the curated dev process dashboard (web, test db, docs)
[group('dev')]
dev:
    mprocs

# Next.js dev server (port 3000)
[group('dev')]
web:
    pnpm dev

# MkDocs Material docs site, hot-reloading
[group('dev')]
docs-serve:
    bash scripts/docs-serve.sh

# --- build ---------------------------------------------------------------

# Production build of every workspace (turbo-cached)
[group('build')]
build:
    turbo run build

# --- db ---------------------------------------------------------------

# Run Prisma migrate for env=local|preview|prod (⚠ prod touches production)
[group('db')]
db-migrate env="local":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in
      local)   pnpm --filter spiralclass-web prisma:migrate ;;
      preview) pnpm --filter spiralclass-web migrate:preview ;;
      prod)    pnpm --filter spiralclass-web migrate:prod ;;
      *) echo "unknown env: {{env}} (want local|preview|prod)" >&2; exit 1 ;;
    esac

# Check Prisma migration status for env=local|preview|prod
[group('db')]
db-migrate-status env="preview":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in
      local)   pnpm --filter spiralclass-web prisma:validate ;;
      preview) pnpm --filter spiralclass-web migrate:preview:status ;;
      prod)    pnpm --filter spiralclass-web migrate:prod:status ;;
      *) echo "unknown env: {{env}} (want local|preview|prod)" >&2; exit 1 ;;
    esac

# Open Prisma Studio against the local DB
[group('db')]
db-studio:
    pnpm --filter spiralclass-web prisma:studio

# Seed the DB for env=local|preview (⚠ preview via Infisical, writes real data)
[group('db')]
seed env="local":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in
      local)   pnpm --filter spiralclass-web seed ;;
      preview) pnpm seed:preview ;;
      *) echo "unknown env: {{env}} (want local|preview)" >&2; exit 1 ;;
    esac

# Start the local Postgres test DB (docker compose)
[group('db')]
db-test-up:
    pnpm --filter spiralclass-web db:test:up

# Stop and wipe the local Postgres test DB
[group('db')]
db-test-down:
    pnpm --filter spiralclass-web db:test:down

# --- checks ---------------------------------------------------------------
#
# These recipes were DELIBERATELY absent until now: the justfile was a
# launcher for long-lived dev processes, and keeping checks on the `pnpm`
# surface meant exactly one canonical invocation per check. That reasoning was
# written while the no-local-tests policy (D-116) was in force and running a
# suite locally was not a thing anyone did; both premises are gone.
#
# What has NOT changed: `just` is a HUMAN front door. Every recipe below
# delegates to the same pnpm command it always was, adds no logic of its own,
# and agents keep calling pnpm directly (CLAUDE.md). If a recipe here ever does
# something the pnpm script does not, that is the bug.

# Typecheck every workspace (tsc --noEmit)
[group('checks')]
typecheck:
    pnpm typecheck

# Lint every workspace
[group('checks')]
lint:
    pnpm lint

# Unit tests, every workspace
[group('checks')]
test:
    pnpm test

# Unit tests for one file, e.g. `just test-file src/lib/money.test.ts`
[group('checks')]
test-file FILE:
    pnpm --filter spiralclass-web test -- {{FILE}}

# Unit tests in watch mode (web)
[group('checks')]
test-watch:
    pnpm --filter spiralclass-web test:watch

# Web unit tests with coverage
[group('checks')]
coverage:
    pnpm --filter spiralclass-web test:coverage

# Integration tests — boots the throwaway Postgres for you
[group('checks')]
test-integration:
    pnpm test:integration:local

# Playwright happy-path E2E (web)
[group('checks')]
test-e2e:
    pnpm test:e2e

# Accessibility sweep (axe)
[group('checks')]
test-a11y:
    pnpm --filter spiralclass-web test:a11y

# Visual regression against the committed baselines
[group('checks')]
test-visual:
    pnpm --filter spiralclass-web test:visual:regression

# Prettier over the whole repo
[group('checks')]
format:
    pnpm format

# --- gate ---------------------------------------------------------------

# The merge gate: format, typecheck, lint, unit+coverage, audit
[group('gate')]
gate:
    pnpm gate

# The merge gate, tolerating uncommitted work — for use mid-task
[group('gate')]
gate-dirty:
    pnpm gate --allow-dirty

# The promote gate: everything, plus mutation, integration and E2E
[group('gate')]
gate-full:
    pnpm gate:full

# Re-run one gate step, e.g. `just gate-only e2e`
[group('gate')]
gate-only STEP:
    pnpm gate --only {{STEP}}

# Name every gate step
[group('gate')]
gate-list:
    pnpm gate --list

# Post the local-gate status for the last receipt (after a push)
[group('gate')]
gate-status:
    pnpm gate:status

# --- ship ---------------------------------------------------------------

# Deploy preview when this commit changed it
[group('ship')]
ship-preview:
    pnpm ship:preview

# Read the runners' verdict, fast-forward production, deploy, then probe it
[group('ship')]
promote:
    pnpm promote

# What this machine has shipped vs origin/main and origin/production
[group('ship')]
release-status:
    pnpm release:status

# --- maintenance ---------------------------------------------------------

# Run a former cron by hand: `just local synthetic` or `just local sweep`
[group('maintenance')]
local JOB:
    pnpm local {{JOB}}

# When each maintenance job last succeeded, and what is overdue
[group('maintenance')]
local-status:
    pnpm local:status

# --- deploy / ops ---------------------------------------------------------

# Hand-deploy web to env=preview|production (⚠ production skips the promote gate)
[group('deploy')]
fly-deploy env="preview":
    bash scripts/fly-deploy.sh {{env}}

# Sync Inngest function definitions against a deployed endpoint (⚠ touches the target env)
[group('deploy')]
inngest-sync url:
    bash scripts/inngest-sync.sh {{url}}

# Seed the preview DB via Infisical, no secrets written to disk (⚠ touches preview)
[group('ops')]
seed-preview:
    pnpm seed:preview

# Reset (drop + re-migrate) THEN reseed the preview DB via Infisical (⚠ destroys all preview data)
[group('ops')]
reset-preview:
    pnpm reset:preview

# Probe the UAT environment's health
[group('ops')]
uat-probe:
    pnpm uat:probe

# Verify UAT results against expectations
[group('ops')]
uat-verify:
    pnpm --filter spiralclass-web uat:verify

# Connect a teacher's Wise payout account
[group('ops')]
wise-connect:
    pnpm --filter spiralclass-web wise:connect

# Extract platform economics usage data for env=local|preview
[group('ops')]
economics-usage env="local":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{env}}" in
      local)   pnpm --filter spiralclass-web economics:usage ;;
      preview) pnpm --filter spiralclass-web economics:usage:preview ;;
      *) echo "unknown env: {{env}} (want local|preview)" >&2; exit 1 ;;
    esac

# Delete a student's roster data (⚠ destructive, targets the LOCAL db in config/env/local.runtime.env)
[group('ops')]
cleanup-roster:
    pnpm --filter spiralclass-web cleanup:roster

# --- ci (CI only — for local spot-checks, not part of the push gate) ------

# Run the money-math mutation spot-check locally
[group('ci')]
mutation-spotcheck:
    pnpm --filter spiralclass-web mutation:spotcheck

# Run the diff-coverage check locally
[group('ci')]
diff-coverage:
    pnpm --filter spiralclass-web diff:coverage
