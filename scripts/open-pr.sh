#!/usr/bin/env bash
set -euo pipefail

# open-pr.sh — take the work in THIS worktree from committed to a PR that can
# merge: name the branch, push it (which runs the gate), open or update the PR,
# and report whether the `local-gate` status branch protection requires actually
# arrived.
#
# This is the FRONT half of the shipping path, and it stops at "PR #N is open
# and green". The back half is `gh pr merge` and then `pnpm promote`.
#
# It used to be scripts/ship-pr.sh, which drained open PRs in a batch and held
# the machine for 20-40 minutes running the full tier against merged `main`.
# [D-162] deleted it: `.github/workflows/heavy.yml` runs those suites on every
# PR and on every push to `main`, so the merged-tree check happens on a runner
# and this laptop is not in the path at all.
#
# This script still never merges, never deploys and never promotes. That is no
# longer about contention — it is that opening a PR and shipping one are
# different decisions, and a command that quietly did both would make the second
# one by accident.
#
#   scripts/open-pr.sh --title "..." --body-file /tmp/body.md
#   scripts/open-pr.sh --branch fix-checkout-currency --title "..."
#   scripts/open-pr.sh --rebase --title "..."     # onto origin/main first
#   scripts/open-pr.sh --draft --title "..."
#   pnpm pr --title "..."
#
# The COMMIT is not this script's job. Whoever calls it has already committed —
# the message, its trailers and the PR body are judgement, and a script that
# generated them would generate them badly. This does the mechanical half,
# which is the half with the sharp edges.

BRANCH=""
TITLE=""
BODY_FILE=""
DRAFT=0
REBASE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch | --title | --body-file)
      [ -n "${2:-}" ] || {
        echo "open-pr: $1 needs a value" >&2
        exit 2
      }
      case "$1" in
        --branch) BRANCH="$2" ;;
        --title) TITLE="$2" ;;
        --body-file) BODY_FILE="$2" ;;
      esac
      shift
      ;;
    --draft) DRAFT=1 ;;
    --rebase) REBASE=1 ;;
    -h | --help)
      sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "open-pr: unknown argument '$1'" >&2 && exit 2 ;;
  esac
  shift
done

die() {
  echo "" >&2
  echo "open-pr: $*" >&2
  echo "" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "gh not found — this needs an authenticated gh CLI."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth status failed)."
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository."

# Uncommitted work is a caller error, not something to paper over. Committing
# for them would mean inventing a message, and the message is the part of a
# commit that has to be thought about in this repo.
if [ -n "$(git status --porcelain)" ]; then
  echo "open-pr: the working tree is dirty. Commit (or stash) first:" >&2
  git status --short >&2
  die "nothing pushed."
fi

git fetch --no-tags --quiet origin main

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT" != "main" ] || die "HEAD is on 'main'. Branch first — this repo takes no direct pushes to main."
[ "$CURRENT" != "production" ] || die "HEAD is on 'production'. That branch is only ever fast-forwarded by a promote, never by hand."

AHEAD="$(git rev-list --count origin/main..HEAD)"
[ "$AHEAD" -gt 0 ] || die "HEAD has no commits that origin/main doesn't. There is nothing to open a PR for."

# ── Name the branch ──────────────────────────────────────────────────────────
#
# A session usually arrives here detached, or on the harness's auto-generated
# `worktree-<adjective>-<verb>-<noun>` branch. Neither says anything about the
# change, and both have shipped as PR head refs before (#986, #981, #977). A
# real name is cheap here and unrecoverable later — the branch is deleted on
# merge, but it is what the PR list shows while the PR is open.
derive_branch() {
  git log -1 --pretty=%s |
    tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//' |
    cut -c1-48 |
    sed -e 's/-*$//'
}

DETACHED=0
[ "$CURRENT" != "HEAD" ] || DETACHED=1

if [ -z "$BRANCH" ]; then
  if [ "$DETACHED" = "1" ] || echo "$CURRENT" | grep -q '^worktree-'; then
    BRANCH="$(derive_branch)"
    [ -n "$BRANCH" ] || die "could not derive a branch name from the last commit subject — pass --branch."
  else
    BRANCH="$CURRENT"
  fi
fi

# Someone else's branch is never force-moved. Two sessions deriving the same
# name from similar commit subjects is the realistic collision, and the cost of
# guessing wrong is another session's work overwritten.
if [ "$BRANCH" != "$CURRENT" ] && git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  die "origin/$BRANCH already exists and isn't what you're on. Pass a different --branch."
fi

if [ "$BRANCH" != "$CURRENT" ]; then
  if [ "$DETACHED" = "1" ]; then
    git checkout --quiet -b "$BRANCH"
  else
    git branch --quiet -m "$BRANCH"
  fi
  echo "  branch   $CURRENT → $BRANCH"
else
  echo "  branch   $BRANCH"
fi

# ── Freshness ────────────────────────────────────────────────────────────────
#
# A worktree can sit on an old base for days. The PR opens either way; what a
# stale base buys is a conflict discovered at merge time, or a heavy run that
# tested a tree the merge will not produce. Say the number now.
BEHIND="$(git rev-list --count HEAD..origin/main)"
if [ "$REBASE" = "1" ] && [ "$BEHIND" -gt 0 ]; then
  echo "  rebase   onto origin/main ($BEHIND commit(s) behind)"
  git rebase origin/main || die "the rebase stopped on a conflict. Resolve it, then re-run."
  BEHIND=0
fi
echo "  base     $AHEAD commit(s) ahead, $BEHIND behind origin/main"
if [ "$BEHIND" -gt 30 ]; then
  echo "  ⚠ that is a long way behind — consider --rebase before the merge conflicts."
fi

# ── Push ─────────────────────────────────────────────────────────────────────
#
# This is where the gate runs (.githooks/pre-push → the FAST tier) and where the
# `local-gate` status comes from. It is also where the run can appear to hang:
# the gate takes the machine-wide lock, so a push queues behind whichever
# session is already gating. That is working as intended — say so before the
# silence, because the wrong reaction (kill it, retry it in another shell,
# reach for SKIP_GATE) is the one that costs something.
#
# No bypass flag is ever passed. Red code does not leave this machine.
echo ""
echo "── Pushing $BRANCH (the gate runs now — this queues if another session holds the machine)"
if ! git push --quiet -u origin "HEAD:refs/heads/$BRANCH"; then
  die "the push failed — most likely the gate is red (see above). Nothing was opened."
fi
SHA="$(git rev-parse HEAD)"

# ── Open or update the PR ────────────────────────────────────────────────────
#
# A re-run on a branch that already has a PR is the normal way to add a commit
# to one, so an existing PR is reported rather than treated as an error: the
# push above already updated it.
PR="$(gh pr list --head "$BRANCH" --state open --base main --json number --jq '.[0].number // empty' 2>/dev/null || true)"

if [ -n "$PR" ]; then
  echo "  PR       #$PR already open for $BRANCH — updated by the push."
else
  [ -n "$TITLE" ] || TITLE="$(git log -1 --pretty=%s)"
  CREATE_ARGS=(--base main --head "$BRANCH" --title "$TITLE")
  if [ -n "$BODY_FILE" ]; then
    [ -f "$BODY_FILE" ] || die "--body-file '$BODY_FILE' does not exist."
    CREATE_ARGS+=(--body-file "$BODY_FILE")
  else
    CREATE_ARGS+=(--body "$(git log --reverse --pretty='%b' origin/main..HEAD)")
  fi
  [ "$DRAFT" = "0" ] || CREATE_ARGS+=(--draft)

  gh pr create "${CREATE_ARGS[@]}" >/dev/null || die "gh pr create failed — the branch is pushed; open the PR by hand."
  PR="$(gh pr list --head "$BRANCH" --state open --base main --json number --jq '.[0].number // empty')"
  [ -n "$PR" ] || die "the PR was created but could not be read back. Check GitHub."
  echo "  PR       #$PR opened"
fi

# ── The status branch protection actually waits on ───────────────────────────
#
# The gate passed above, but the status is posted by a DETACHED process
# (scripts/ci/status.mjs), which waits for the push to land before it can
# attach anything to the SHA. So green-locally and green-on-GitHub are two
# facts, and only the second one unblocks the merge button. Ask for the second.
echo ""
printf "  local-gate  "
STATE=pending
for _ in $(seq 1 24); do
  STATE="$(gh api "repos/{owner}/{repo}/commits/$SHA/status" \
    --jq '[.statuses[] | select(.context == "local-gate")][0].state // "pending"' 2>/dev/null || echo pending)"
  [ "$STATE" = "pending" ] || break
  printf "."
  sleep 5
done

case "$STATE" in
  success) echo " green" ;;
  pending)
    echo " not posted yet."
    echo "    The gate was green or the push would have failed; the poster runs detached."
    echo "    Check again:  pnpm gate:status"
    ;;
  *)
    echo " $STATE"
    echo "    The PR cannot merge until this is green. Do NOT bypass it."
    ;;
esac

URL="$(gh pr view "$PR" --json url --jq .url 2>/dev/null || echo "")"
echo ""
echo "  ✓ #$PR  ${URL}"
echo ""
# Deliberately NOT printing the merge command. A guard test asserts this script
# contains no way to merge, deploy or promote, and it cannot tell an echo from an
# invocation — which is the right trade: the string being absent is what makes
# the guard mean anything.
echo "    The heavy suites run on this PR too and do not block the merge button."
echo "    Read them before merging it."
echo ""
