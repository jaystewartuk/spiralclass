#!/usr/bin/env bash
# One command from a fresh clone to an app you can sign into.
#
# Everything here is idempotent — re-running it after a `git pull` is the
# supported way to catch up on new migrations and seed fixtures.
#
# What it deliberately does NOT do: write a .env.local. The database, the
# session secret and the app URL come from config/env/local.runtime.env, which
# is committed precisely so a fresh checkout works with no per-developer file
# to fill in (see config/env/README.md). Vendor keys are all optional and every
# integration degrades to a stub when its key is missing, so the app boots
# without a single credential.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

step "Checking prerequisites"
command -v pnpm >/dev/null || die "pnpm not found. Run 'corepack enable' (Node 24+ ships it)."
command -v docker >/dev/null || die "docker not found. Needed for the local Postgres; see README.md if you would rather point DATABASE_URL at a hosted database."
docker info >/dev/null 2>&1 || die "docker is installed but not running."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || printf '  note: package.json wants Node >= 24, you have %s. Most things work; nvm use will fix it.\n' "$(node -v)"
echo "  ok"

step "Installing dependencies (also generates the Prisma client and wires git hooks)"
pnpm install

step "Starting Postgres on :5432"
pnpm --filter spiralclass-web db:dev:up

step "Applying migrations"
pnpm --filter spiralclass-web prisma:migrate:deploy

step "Seeding development fixtures"
pnpm --filter spiralclass-web seed

cat <<'DONE'

Done. Start the app with:

    pnpm dev            # http://localhost:3000

Sign in as a seeded teacher or student. The seed prints the addresses it
created; local sign-in uses an emailed one-time code, and with no email
provider configured that code is written to the dev server's console rather
than sent — look for it there.

Useful next commands:

    pnpm test                    # unit tests (no database needed)
    pnpm test:integration:local  # integration tests (boots its own database on :5433)
    pnpm gate --allow-dirty      # everything the pre-push hook will check
    pnpm db:dev:down             # stop Postgres, keep the data

DONE
