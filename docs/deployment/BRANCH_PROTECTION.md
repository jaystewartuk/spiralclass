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
| — Required checks                             | **`local-gate`**          | The one required context — posted by the local gate on this machine, and by nothing else (see below)                                                    |
| — Require branches up to date (`strict`)      | **Off**                   | "On" forces a rebase + full re-run every time `main` moves — churn with auto-merge at solo/low concurrency. Turn on only if you run many concurrent PRs |
| Require linear history                        | ✅                        | Pairs with squash-only merges; blocks accidental merge commits                                                                                          |
| Require conversation resolution               | Off                       | No reviewers                                                                                                                                            |
| Require signed commits                        | Off                       | Friction with no payoff solo                                                                                                                            |
| Do not allow bypassing (`enforce_admins`)     | **On** (as of 2026-08-04) | Every change — docs included — lands via a PR; the docs-only / Tier-1 admin-bypass fast path is retired. Re-apply with the script after any drift       |
| Allow force pushes                            | **Off**                   | Protect `main` history                                                                                                                                  |
| Allow deletions                               | **Off**                   | Protect `main`                                                                                                                                          |

### The required check — `local-gate`, and only it ⚠️

CI runs on the operator's machine (D-119). The merge gate is a **commit status**
named `local-gate`, which is posted by two producers that run the same tier:

- `scripts/ci/status.mjs`, after `pnpm gate` (normally via `.githooks/pre-push`,
  which runs the fast tier on the commit being pushed and posts once the push
  lands).
- ~~`.github/workflows/main-checks.yml`'s `status` job~~ — **gone**. D-129
  deleted every workflow in this repo, so the local gate is now the only
  producer of this context. A session that cannot run it (no `gh`, no laptop)
  cannot get the status onto the PR at all; say so rather than implying a check
  ran.

A commit status attaches to **one commit**, so a green `local-gate` cannot drift
onto later work: push another commit and the PR is unmergeable again until that
commit is certified too. That is the property being bought here; it is not
resistant to someone posting green by hand, which is an accepted trade for a
solo repo (see D-119's unresolved risks).

Do **not** require any `checks / …` context. Those jobs no longer exist at all
(D-129); before that they only ran on dispatch
now, so requiring one would leave every PR waiting for a run nobody started —
the exact failure the 2026-07-18 manual-only sweep caused, which Phase 1 had to
undo on 2026-07-20. (Before D-119 the required check was the aggregate
`checks / Typecheck / lint / unit / audit` job, for a related reason: its
sub-jobs include a `mutation` job that is _skipped_ on PRs, and a required
skipped check never posts success.)

There used to be a second required check, `PR integration gate`
(`pr-integration.yml`), running the real-DB integration suite on web-touching
PRs. It was moved back to promote-only on 2026-07-21 — a
deliberate cost trade — and removed outright once demoted, since it was never a
required status check. That suite is `pnpm gate:full`, and since D-129 that is
the only place it exists.

## `production` — do NOT put a blocking rule on it

`production` is written only by a promote fast-forward — `pnpm promote` from the
operator's machine (D-119). That is now the only writer: the `promote.yml`
fallback, which pushed with a `PROMOTE_TOKEN` PAT, was deleted along with every
other workflow in D-129. A "require a pull request" or "require status
checks" rule on `production` would **reject that push and break deploys**.
Production is already gated upstream — promote refuses to fast-forward unless
the Gate and Heavy workflows are both green for the exact commit
([D-162](../decisions/D-162.md)), and `--force-gate` runs the full tier locally
instead when the verdict cannot be read.

`scripts/setup-branch-protection.sh` applies a **ruleset** (not classic
protection) named `production: fast-forward only, no delete`, with two rules:

- `non_fast_forward` — blocks force-pushes, so `production` history can't be
  rewritten. A normal fast-forward is not a force-push, so the promote push
  passes untouched (no bypass actor needed).
- `deletion` — blocks dropping the branch.

It deliberately adds **no** required-PR / required-status / required-reviewer
rule — any of those would reject the promote fast-forward. Never add one.

> **The required-reviewer rule belongs on the `production` GitHub
> _Environment_, not on the branch.** ⚠️ This paragraph said the opposite until
> the 2026-09 documentation pass, and was written when D-129 had left no
> workflow for such a rule to gate. [D-157](../decisions/D-157.md) restored
> `deploy-production.yml` and put the human checkpoint there deliberately: the
> environment approval is a queued run with a notification attached, which is
> the opposite of the forgettable manual dispatch step that once left
> `production` 96 commits behind live. A protection rule on the _branch_ would
> still reject the promote fast-forward — that part has not changed. Never add
> one there.

## Paired repo settings (Settings → General → Pull Requests)

- **Allow squash merging** ✅, and turn **merge commits** and **rebase** off —
  makes squash automatic and pairs with "require linear history."
- **Allow auto-merge** ✅ — enable per finished PR; it merges the moment the
  required check goes green (blast radius is preview only; prod stays behind
  promote).
- **Automatically delete head branches** ✅ — cleanup after merge.
