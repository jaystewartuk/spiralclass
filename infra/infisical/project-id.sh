#!/usr/bin/env bash
# Resolve THIS project's Infisical id — and refuse to run against a different
# project's. SOURCE this, then call `infisical_project_id`.
#
# WHY THIS EXISTS. The project link moved to $HOME so that nothing about the
# project lives in this repository. That removed a safety property nobody had
# named: a .infisical.json INSIDE the repo could only ever point at this
# project. One in $HOME points at whichever project `infisical init` was last
# aimed at, and this account has three.
#
# ⚠️ WHAT THAT COSTS, CONCRETELY. infra/infisical/push-fly-secrets.sh runs
# `fly secrets import` with whatever the export returned: aimed at the wrong
# project it overwrites EVERY production secret with another project's values
# and restarts the running machines. scripts/fly-deploy.sh would deploy against
# another project's DATABASE_URL. Neither fails first — both succeed at doing
# the wrong thing.
#
# THE CHECK IS A HASH, NOT THE ID. infra/infisical/project.sha256 holds
# SHA-256 of the workspace id. The id itself stays out of the repository and
# does not need to be in it: a hash of a UUID is not an identifier — 122 bits
# of entropy behind a preimage-resistant function — and equality is the only
# thing the check needs. Rotate it with:
#
#   node -pe "require(process.env.HOME + '/.infisical.json').workspaceId" \
#     | tr -d '\n' | shasum -a 256 | cut -d' ' -f1 > infra/infisical/project.sha256

infisical_project_id() {
  local dir id expected actual
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  # Exported id, then a repo-local link, then ~/.infisical.json.
  id="${INFISICAL_PROJECT_ID:-}"
  [ -n "$id" ] || id="$(node -pe "require('$dir/.infisical.json').workspaceId" 2>/dev/null || true)"
  [ -n "$id" ] || id="$(node -pe "require(process.env.HOME + '/.infisical.json').workspaceId" 2>/dev/null || true)"

  [ -n "$id" ] || {
    echo "No Infisical project id. Run \`infisical init\` in \$HOME, export" >&2
    echo "INFISICAL_PROJECT_ID, or create $dir/.infisical.json (D-158)." >&2
    return 1
  }

  # ⚠️ An escape hatch, because a guard that cannot be bypassed is a guard that
  # can strand a cutover at 02:00. Deliberate, loud, and never the default.
  if [ -n "${INFISICAL_SKIP_PROJECT_CHECK:-}" ]; then
    echo "⚠️  INFISICAL_SKIP_PROJECT_CHECK set — NOT verifying which project this is." >&2
    printf '%s\n' "$id"; return 0
  fi

  [ -f "$dir/project.sha256" ] || {
    echo "Missing $dir/project.sha256 — cannot verify which project this is." >&2
    return 1
  }
  expected="$(tr -d '[:space:]' < "$dir/project.sha256")"
  actual="$(printf '%s' "$id" | shasum -a 256 | cut -d' ' -f1)"

  [ "$actual" = "$expected" ] || {
    echo "WRONG INFISICAL PROJECT." >&2
    echo "  The resolved project is not the one this repository belongs to." >&2
    echo "  Run \`infisical init\` and choose spiralclass, or export the right" >&2
    echo "  INFISICAL_PROJECT_ID. Refusing rather than reading another" >&2
    echo "  project's secrets into this application." >&2
    return 1
  }
  printf '%s\n' "$id"
}
