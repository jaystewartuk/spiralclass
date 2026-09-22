#!/usr/bin/env bash
# Time-bomb sweep — re-run the clock-sensitive checks against TODAY's date.
# Run it: `pnpm local sweep`.
#
# The local port of the deleted .github/workflows/nightly-checks.yml (D-129).
#
# WHY THIS EXISTS AT ALL, given the same suites run on every push: a
# time-dependent test — one whose assertion holds only while the wall clock sits
# on one side of a hard-coded date — passes every push-time and promote-time run
# and then trips silently later, on an unrelated commit. A push-triggered gate
# cannot catch that class. Only a clock that advanced can, which is why this is
# a separate thing you run rather than a step in the gate.
#
# It runs the same three checks the nightly cron was slimmed to (D-119): the two
# unit suites and the dependency audit. Typecheck, lint, formatting and the
# mutation spot-check are pure functions of the committed tree — on an unchanged
# `main` they can only reproduce the answer the gate already got.
#
# DIFFERENCE FROM THE WORKFLOW, stated rather than buried: the cron always ran
# against `main`, because a scheduled workflow can only run on the default
# branch. This runs against YOUR CHECKOUT. That is a superset in the case that
# matters — a time bomb lives in committed test code, and your checkout contains
# it — but a local edit can colour the result, so the sweep prints exactly what
# it tested before it starts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "Sweep date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

git fetch --quiet origin main 2>/dev/null || echo "  (could not fetch origin/main — reporting local state only)"

HEAD_SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Testing:    $BRANCH @ $HEAD_SHA"

if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
    AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
    echo "  ! not origin/main — $AHEAD ahead, $BEHIND behind."
    echo "    A red result here may be this branch rather than a time bomb on main."
  fi
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "  ! working tree is dirty — uncommitted changes are part of what gets tested."
fi

echo ""
# `test-mobile` was in this list until the step was unregistered and the app
# it covered deleted, and this
# line was not updated with it — so the gate rejected the unknown id and the
# sweep exited 2 in about a second, before running anything at all. It had
# never been green since. The maintenance nag faithfully reported that every
# week and read as "nobody has got round to it" rather than "this is broken".
#
# The ids are joined to the registry by a test now (tests/config/local-gate),
# so unregistering a step fails there instead of here, silently, later.
exec node scripts/ci/gate.mjs \
  --only test-web,audit \
  --no-post --allow-dirty --quiet-header
