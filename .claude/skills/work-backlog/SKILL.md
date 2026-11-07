---
name: work-backlog
description: Take the next eligible SpiralClass p1 issue through a tested pull request, or resume unfinished backlog work. Use when asked to work through the backlog; stop at one PR for review. Does not run on project open or on a schedule.
---

# Work the backlog

Run only when the user asks to work the backlog. One invocation delivers at
most one issue's PR for review. GitHub is the queue; do not maintain a local
backlog, read private direction documents, or hardcode issue numbers here.

For a sustained run, the user can invoke:

```text
/goal Use $work-backlog to take the next eligible p1 issue through a tested PR.
Stop when the PR is ready for my review or you need a product decision.
```

## Find unfinished work before selecting

Read `CLAUDE.md` and inspect the current branch, dirty files, local worktrees,
and open PRs. Preserve other sessions' work. Use the connected GitHub tools
when sufficient; otherwise use the authenticated `gh` CLI. A connector 403
does not mean CLI credentials are missing. Respect execution permissions.

```bash
git status --short
git worktree list
gh pr list --state open --base main --limit 100 --json number,title,body,headRefName,url,isDraft
gh issue list --state open --label p1 --limit 100 --json number,title,body,labels,url
```

Paginate if a result reaches its limit. Read issue comments and linked PRs,
including draft PRs; title matching alone cannot establish ownership of work.
If unfinished backlog work belongs to this session, resume it in its existing
worktree. If its PR is ready for review, report its URL and stop. Do not modify
another active session's branch. If any other backlog PR is open, including a
draft, report it and stop instead of opening a competing PR. Keep at most one
outstanding backlog PR across invocations. Unclear ownership is a blocker.
Use a branch named `backlog-<issue-number>-<short-topic>` for new backlog work;
its linked issue and PR identify the workflow on a later invocation, but do
not prove that another session has stopped using the worktree.

## Select one eligible issue

Use live `p1` issues only, unless the user explicitly widens the scope. Never
fall through to `p2` or deferred `p3` work just because no p1 is eligible.
Prioritize a confirmed interruption to live classes or payments, then measured
user friction, then bounded work that improves the engineering evidence.
Break ties by the oldest issue number. Do not infer urgency from label alone.

Read the full issue and comments, the owning feature document, and the current
code. Ask decision-scout for constraining decisions when the work would change
existing behaviour or policy. A stale issue is not permission to restore a
retired design. Check prerequisites and existing PRs before starting.

Skip an issue that is already covered, obsolete, blocked by an unmerged
dependency, needs unavailable production evidence or an operator action, or
cannot be scoped without a product decision. Report why and consider the next
eligible p1. If none qualify, stop with the blockers; do not invent work.
If a security problem is found, stop that issue's public workflow and follow
`SECURITY.md`; do not publish exploit details, push a security fix early for CI,
or quietly downgrade its priority.

Do not edit, close, relabel, assign, or comment on issues as bookkeeping.
New findings go through the issue skill at `.claude/skills/issue/SKILL.md`,
including its draft approval. Never broaden the fix into those findings.

## Fix and verify

For new work, fetch current `origin/main` and create a fresh worktree and
descriptive branch. Keep one issue per PR; never stack on an unmerged backlog
PR. Recheck open PRs immediately before starting so another session's work
is not duplicated. Identify the selected issue and the behaviour to verify.

Reproduce the bug and run the regression test before the fix: record that it
failed for the expected reason, then make it pass. For new behaviour, test its
acceptance criteria. If the claimed bug cannot be reproduced, do not manufacture
a fix. Investigate within scope or report the missing evidence.

Follow the repository's testing and security-review requirements, including
explicit security review for Tier 2 changes. See UI changes rendered in Chrome
at phone and desktop widths and in the affected locale. For call changes, read
`.claude/skills/call-local/SKILL.md` and perform its teacher/student check.
Run `pnpm gate --allow-dirty`, fix failures caused by this work, and respect
the machine lock. Never bypass the gate or weaken checks to obtain green.
If required evidence or permissions are unavailable, preserve the work and
report the blocker rather than claiming the issue is finished.

## Deliver and stop

Read and follow `.claude/skills/pr/SKILL.md` to commit, push through the gate,
and open or update the PR. Use `Closes #N` only when its acceptance criteria
are met; partial work uses `Refs #N`. Report the regression evidence, checks
actually observed, PR URL, local-gate status and Heavy status. Pending is not
green. Never merge, deploy or promote, and never schedule the next run.

Stop after this PR is ready for review; do not start a second issue in the
same invocation. On a later invocation, inspect live GitHub state again.
After a PR is merged or abandoned, remove only this workflow's clean, unused
worktree from another checkout; preserve worktrees with unpushed or dirty work.
