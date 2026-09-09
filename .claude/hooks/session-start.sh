#!/bin/bash
# SessionStart — make the checkout runnable, and only when it is not.
#
# Every session used to run a full `pnpm install`, which on a warm store still
# costs ~10 seconds of wall clock before the first prompt and re-links 1,700
# packages in a worktree that almost always already has them. Several sessions
# work this repository at once, each in its own worktree, so that cost is paid
# per session rather than per change.
#
# The install is still necessary — a worktree is a fresh checkout with no
# node_modules, and `prisma generate` has to have run before anything
# type-checks — so this keeps it and adds the only thing it was missing: a
# reason to skip. The receipt records the lockfile and the workspace manifest
# that were installed; if both still hash the same and node_modules is present,
# there is nothing to do.
#
# Fails open throughout. A session that cannot install is one where the agent
# gets a legible error from the first command it runs, which is better than a
# hook that halts the session before it starts.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

corepack enable >/dev/null 2>&1 || true
corepack prepare "$(node -p "require('./package.json').packageManager" 2>/dev/null)" --activate >/dev/null 2>&1 || true

receipt="node_modules/.spiralclass-install-receipt"
current="$(cat pnpm-lock.yaml pnpm-workspace.yaml package.json 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"

if [[ -d node_modules && -n "$current" && -f "$receipt" && "$(cat "$receipt" 2>/dev/null)" == "$current" ]]; then
  echo "Dependencies are current (lockfile unchanged since the last install)."
  exit 0
fi

if pnpm install --prefer-offline; then
  [[ -n "$current" ]] && printf '%s' "$current" >"$receipt" 2>/dev/null || true
fi

exit 0
