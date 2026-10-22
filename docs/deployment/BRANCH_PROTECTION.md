# Branch protection

The canonical protection for `main`, why each setting is what it is, and how to
(re)apply it. This exists because the rule is a _settings-page_ object, not code
— so it can be deleted or drift with nothing in version control to restore it.
This doc + `scripts/setup-branch-protection.sh` are that version control.

> **Reapply any time:** `scripts/setup-branch-protection.sh`
> (needs the GitHub CLI authenticated with admin on the repo; idempotent).

## `main` — the rule

| Setting                                       | Value                     | Why                                                                                                                                                     |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Require a pull request before merging         | ✅                        | Every change lands via a PR                                                                                                                             |
| — Required approvals                          | **0**                     | Solo dev — the CI check is the gate, not a second reviewer                                                                                              |
| — Dismiss stale approvals / code-owner review | Off                       | No reviewers / no `CODEOWNERS`                                                                                                                          |
| Require status checks to pass                 | ✅                        | The merge gate                                                                                                                                          |
| — Required checks                             | **`local-gate`**          | The one required context — posted by the pre-push gate and by `gate.yml`, both running the same registry (see below)                                    |
| — Require branches up to date (`strict`)      | **Off**                   | "On" forces a rebase + full re-run every time `main` moves — churn with auto-merge at solo/low concurrency. Turn on only if you run many concurrent PRs |
| Require linear history                        | ✅                        | Pairs with squash-only merges; blocks accidental merge commits                                                                                          |
| Require conversation resolution               | Off                       | No reviewers                                                                                                                                            |
| Require signed commits                        | Off                       | Friction with no payoff solo                                                                                                                            |
| Do not allow bypassing (`enforce_admins`)     | **On** (as of 2026-08-04) | Every change — docs included — lands via a PR; the docs-only / Tier-1 admin-bypass fast path is retired. Re-apply with the script after any drift       |
| Allow force pushes                            | **Off**                   | Protect `main` history                                                                                                                                  |
| Allow deletions                               | **Off**                   | Protect `main`                                                                                                                                          |

### The required check — `local-gate`, and only it ⚠️

The merge gate is a **commit status** named `local-gate`, which is posted by two
producers that run the same tier from the same registry
(`scripts/ci/steps.mjs`):

- `scripts/ci/status.mjs`, after `pnpm gate` (normally via `.githooks/pre-push`,
  which runs the fast tier on the commit being pushed and posts once the push
  lands).
- `.github/workflows/gate.yml`'s `Post the local-gate status` job, on a
  GitHub-hosted runner for every pull request into `main`. Every workflow was
  deleted on 2026-08-25; [D-157](../decisions/D-157.md) brought this one back once the
  repository was public and Actions minutes were free. A session with no
  laptop and no `gh` therefore still gets the status onto its PR — say which
  run you actually saw, and never imply you posted one you did not.

A commit status attaches to **one commit**, so a green `local-gate` cannot drift
onto later work: push another commit and the PR is unmergeable again until that
commit is certified too. That is the property being bought here; it is not
resistant to someone posting green by hand, which is an accepted trade for a
solo repo (see [D-157](../decisions/D-157.md)).

Do **not** require any `checks / …` context. Those jobs no longer exist at all
(they were deleted on 2026-08-25, and `gate.yml` does not recreate them); before that they only ran on dispatch
now, so requiring one would leave every PR waiting for a run nobody started —
the exact failure the 2026-07-18 manual-only sweep caused, which Phase 1 had to
undo on 2026-07-20. (Before 2026-08-12 the required check was the aggregate
`checks / Typecheck / lint / unit / audit` job, for a related reason: its
sub-jobs include a `mutation` job that is _skipped_ on PRs, and a required
skipped check never posts success.)

There used to be a second required check, `PR integration gate`
(`pr-integration.yml`), running the real-DB integration suite on web-touching
PRs. It was moved back to promote-only on 2026-07-21 — a
deliberate cost trade — and removed outright once demoted, since it was never a
required status check. That suite is now in the heavy tier: `heavy.yml` runs it
on a runner for every pull request and every push to `main`
([D-157](../decisions/D-157.md)), and `pnpm gate:full` runs it locally. It is
still not a required status check.

### Code scanning — a ruleset, not a required check ([D-158](../decisions/D-158.md))

The script also turns on **private vulnerability reporting** (the route
`SECURITY.md` promises) and **CodeQL default setup**, then applies a ruleset
named `main: no new CodeQL alerts` with one `code_scanning` rule. It blocks a
merge that _introduces_ a CodeQL alert at severity `error`, or a security alert
at `high` or `critical`.

- It is **not** a required status context, and `local-gate` stays the only one.
  The rule reads the alert database, so alerts already open on `main` do not
  block unrelated PRs, and no job name can strand a PR by moving.
- It has **no bypass actor**. To merge past a false positive, dismiss the alert
  on the Security tab with a reason.
- Never add a `codeql.yml` workflow. Tune the scan through the default setup's
  `query_suite` in the script.

## `production` — do NOT put a blocking rule on it

`production` is written only by a promote fast-forward — `scripts/ci/promote.mjs`,
run by `promote-on-green.yml` when both runners certify a push to `main`
([D-199](../decisions/D-199.md)), or typed by the operator as `pnpm promote`. A
"require a pull request" or "require status checks" rule on `production` would
**reject that push and break deploys**.
Production is already gated upstream — promote refuses to fast-forward unless
the Gate and Heavy workflows are both green for the exact commit
([D-157](../decisions/D-157.md)), and `--force-gate` runs the full tier locally
instead when the verdict cannot be read.

`scripts/setup-branch-protection.sh` applies a **ruleset** (not classic
protection) named `production: fast-forward only, no delete`, with two rules:

- `non_fast_forward` — blocks force-pushes, so `production` history can't be
  rewritten. A normal fast-forward is not a force-push, so the promote push
  passes untouched (no bypass actor needed).
- `deletion` — blocks dropping the branch.

It deliberately adds **no** required-PR / required-status / required-reviewer
rule — any of those would reject the promote fast-forward. Never add one.

### Only the owner ships production

Two more settings make shipping production the repository owner's alone. The
script applies both, and **`pnpm promote` refuses to run unless both hold**:
it reads them live through `scripts/ci/deploy-protection.mjs` before it moves
anything, and it fails closed when it cannot read them.

- **The `production` environment requires the owner's approval** for every
  deploy run, with **admin bypass off** so a push made with the owner's own
  credentials still waits for a click, and **self-review allowed** because the
  one maintainer both pushes and approves. Only the `production` branch may use
  the environment, so its secrets reach no other ref. This is the checkpoint
  [D-157](../decisions/D-157.md) put on the _environment_ rather than the
  branch: a pending approval is a queued run with a notification, not a step
  that can be silently forgotten.
- **A second ruleset, `production: only an admin moves it`**, holds a single
  `update` rule whose only bypass actor is the repository admin role. It does
  not reject the promote fast-forward, because the operator pushing it is the
  admin. It is a **separate** ruleset because a bypass actor bypasses every rule
  in its ruleset: folded into the one above, it would let an admin force-push
  or delete `production`.

⚠️ Until 2026-09-23 this document and the deploy workflow described the
environment reviewer while the environment had none, and a promote deployed with
nobody approving it. The promote check is what keeps that from recurring
unnoticed, and `apps/web/tests/config/production-access.test.ts` holds that
what the script applies is exactly what the check accepts.

### The runner's token — `PROMOTE_TOKEN`

`promote-on-green.yml` has to push as the admin (the ruleset above), and a push
made with `GITHUB_TOKEN` never triggers the deploy. So it uses a token acting
as the owner, made by hand once:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → new.
   Resource owner: the repository's owner. Repository access: **only this
   repository**.
2. Repository permissions: **Contents: read and write** (the fast-forward and
   the release), **Actions: read** (the runners' verdict), **Administration:
   read** (the rulesets and environment that the protection check reads).
   Nothing else.
3. Store it as `PROMOTE_TOKEN` on the **`promote` environment**, never
   repository-wide. The script creates the environment and limits it to
   `main`; a repository-wide secret would reach every branch's workflows.

It can move `production`, and nothing it can do skips the approval: the deploy
it triggers waits on the `production` environment either way. Rotate it like
`GCP_DEPLOY_KEY` (`infra/gcp/README.md`) — before it expires, which a
fine-grained token does. An expired token makes the runner fail red rather than
drift silently, and `pnpm promote` from the laptop still works meanwhile.

## Paired repo settings (Settings → General → Pull Requests)

- **Allow squash merging** ✅, and turn **merge commits** and **rebase** off —
  makes squash automatic and pairs with "require linear history."
- **Allow auto-merge** ✅ — enable per finished PR; it merges the moment the
  required check goes green. ⚠️ Since [D-199](../decisions/D-199.md) a merge
  starts a production deploy, so auto-merge does too; production still waits
  for the owner's approval on the `production` environment.
- **Automatically delete head branches** ✅ — cleanup after merge.
