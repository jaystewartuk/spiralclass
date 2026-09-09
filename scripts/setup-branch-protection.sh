#!/usr/bin/env bash
# Reapply the canonical repo protection: a classic branch-protection rule on
# `main`, plus a ruleset that guards `production` from force-push/deletion while
# still allowing the promote fast-forward. Idempotent — safe to re-run any time
# the config is lost or drifts. Requires the GitHub CLI authenticated
# (`gh auth login`) with admin on the repo.
#
# Rationale for every setting is in docs/deployment/BRANCH_PROTECTION.md. In short:
#
# main (classic branch protection):
#   - Require a PR before merging, 0 required approvals (solo dev — the CI check
#     is the gate, not a second reviewer).
#   - Require one status check: `local-gate` (D-119).
#       * Normally posted by scripts/ci/status.mjs from the operator's machine
#         after `pnpm gate` runs the static+unit tier — CI moved onto the
#         laptop, but the merge button still has to know about it. A commit
#         status binds to ONE commit, so pushing a new commit sends the PR back
#         to "waiting" until that commit is certified too; that's the property
#         worth having.
#       * THERE ARE TWO PRODUCERS AGAIN ([D-157]). This paragraph used to say
#         there were none, which was true only while D-129 had deleted every
#         workflow. `gate.yml`'s `status` job posts the same context from a
#         runner, so a laptop-less day is no longer a stranded PR.
#       * Why `local-gate` and NOT the `gate.yml` job context, which would be
#         the obvious modern choice ([D-162] weighed it and chose this): the
#         laptop posts `local-gate` about 90 seconds after a push, and the
#         runner takes about ten minutes to reach the same verdict. Requiring
#         the job would make every merge wait for the slower of two producers
#         that cannot disagree — they run the same registry. The status is the
#         faster true answer, and speed on the merge path is the whole reason
#         the fast tier stayed on the laptop at all.
#       * ⚠️ A FORK PR CANNOT PRODUCE THIS STATUS, and that is deliberate rather
#         than an oversight. A fork's `pull_request` run gets a read-only token,
#         so `gate.yml`'s status job cannot post — nothing about a fork's code
#         should be able to certify itself. `heavy.yml` and `gate.yml` still RUN
#         on a fork PR, so a contributor sees real verdicts; what they cannot do
#         is mark their own work mergeable. The maintainer runs the gate against
#         the fork head and posts the status. On a repository with one
#         maintainer that is the correct shape, and it is the one thing to
#         explain to an outside contributor rather than let them discover.
#       * Do NOT require a `heavy.yml` context here. It is 17 minutes and it is
#         better read than waited on; `pnpm promote` is what refuses to ship a
#         commit it did not pass ([D-162]), which is the moment that matters.
#   - `PR integration gate` (pr-integration.yml) is gone — the real integration
#     suite it used to gate moved to promote-only on 2026-07-21
#     (a documented, accepted regression in catching
#     route/slug-conflict bugs and migration drift at PR time). The workflow
#     had already been demoted to a permanent always-pass placeholder before
#     it was removed outright, so no required-check migration was needed —
#     it was never in `required_status_checks` to begin with.
#   - Linear history (pairs with squash-only merges).
#   - strict:false — do NOT require branches be up to date (avoids rebase churn
#     with auto-merge at solo / low concurrency).
#   - enforce_admins:true — no admin bypass; every change lands via a PR
#     (2026-08-04, retires the docs-only / Tier-1 fast path).
#   - No force-pushes, no deletion of `main`.
#
# production (ruleset, NOT classic branch protection):
#   - Blocks force-pushes (non_fast_forward) and deletion, so history can't be
#     rewritten or the branch dropped.
#   - Does NOT require a PR or status checks — that would REJECT the promote
#     fast-forward (`pnpm promote`, or promote.yml's PROMOTE_TOKEN push) and
#     break deploys. Promote already ran the full gate upstream. A normal
#     fast-forward is not a force-push, so it passes non_fast_forward
#     untouched; no bypass actor is needed.
set -euo pipefail

REPO="${1:-jaystewartuk/spiralclass}"

command -v gh >/dev/null || { echo "GitHub CLI (gh) is required and must be authenticated: https://cli.github.com" >&2; exit 1; }

# ── main: classic branch protection ──────────────────────────────────────────
echo "Applying branch protection to ${REPO}@main…"
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      { "context": "local-gate" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON
echo "  ✓ main protected."

# ── production: ruleset (fast-forward-only, no delete) ────────────────────────
# A ruleset, not classic protection, so it can add non_fast_forward + deletion
# WITHOUT a required-PR/checks rule that would block the promote fast-forward.
RULESET_NAME="production: fast-forward only, no delete"
RULESET_PAYLOAD="$(cat <<JSON
{
  "name": "${RULESET_NAME}",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/production"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" }, { "type": "deletion" } ]
}
JSON
)"

echo "Applying production ruleset to ${REPO}…"
# Idempotent: update the existing ruleset by name if present, else create it.
RULESET_ID="$(gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name==\"${RULESET_NAME}\") | .id" 2>/dev/null | head -1 || true)"
if [ -n "${RULESET_ID}" ]; then
  echo "  updating existing ruleset (id ${RULESET_ID})…"
  echo "${RULESET_PAYLOAD}" | gh api -X PUT "repos/${REPO}/rulesets/${RULESET_ID}" --input - >/dev/null
else
  echo "  creating ruleset…"
  echo "${RULESET_PAYLOAD}" | gh api -X POST "repos/${REPO}/rulesets" --input - >/dev/null
fi
echo "  ✓ production guarded (no force-push, no deletion; fast-forward still allowed)."

echo
echo "Verify main:"
echo "  gh api repos/${REPO}/branches/main/protection | jq '{required: [.required_status_checks.checks[].context], strict: .required_status_checks.strict, pr_required: (.required_pull_request_reviews!=null), approvals: .required_pull_request_reviews.required_approving_review_count, enforce_admins: .enforce_admins.enabled, linear: .required_linear_history.enabled}'"
echo "Verify production ruleset:"
echo "  gh api repos/${REPO}/rulesets --jq '.[] | select(.name==\"${RULESET_NAME}\") | {name, enforcement, rules: [.rules[]?.type]}'"
