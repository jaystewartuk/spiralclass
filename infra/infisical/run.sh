#!/usr/bin/env bash
# Run a command with this project's Infisical secrets injected, for one
# environment. The generic counterpart to the bespoke wrappers beside it
# (seed-preview.sh, reset-preview.sh), for the many package scripts that need
# nothing more than "the secrets, then the command".
#
#   infra/infisical/run.sh preview tsx scripts/seed.ts
#   infra/infisical/run.sh production prisma migrate status
#
# WHY THIS EXISTS. Every one of those scripts used to be
# `dotenv -e .env.<env>.local -- <cmd>`, which required each developer to keep a
# private, uncommitted file of production and preview database URLs on disk. Two
# things were wrong with that and neither is hypothetical:
#
#   * The file is the copy nobody rotates. A credential that lives only in
#     someone's checkout is invisible to every rotation, audit and offboarding
#     that Infisical exists to make possible.
#   * It silently diverges. `pnpm migrate:preview` failed in this repo simply
#     because the file did not exist on this machine, while the Infisical-backed
#     `seed:preview` beside it worked — two commands against the same database,
#     one of which happened to be reachable.
#
# `infisical run` (a SUBPROCESS injection) is the right primitive here, and
# with-secret.sh's header explains when to reach for the sourced helper instead:
# use that one when a script needs a VALUE partway through its own body. A
# package script that just needs the environment does not.
#
# The secrets are never written to disk, so there is no file to gitignore, to
# forget to rotate, or to be missing on someone else's machine.
#
# Requires: the Infisical CLI, installed and `infisical login`.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <env> <command> [args...]" >&2
  echo "  e.g. $0 preview tsx scripts/seed.ts" >&2
  exit 1
fi

ENV_NAME="$1"
shift

# The closed environment list now lives in infisical.sh, where every caller
# gets it rather than only this one.

# shellcheck source=./infisical.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/infisical.sh"

# ⚠️ infisical_exec REPLACES this process, which is what `exec` did here before
# and is what a wrapper script should do — signals and exit status pass
# straight through to the caller.
infisical_exec "$ENV_NAME" -- "$@"
