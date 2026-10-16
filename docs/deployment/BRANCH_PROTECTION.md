# Branch protection

The canonical protection for `main` and `production`, why each setting is what
it is, and how to re-apply it. The rules are settings-page objects that can be
deleted or drift with nothing in version control to restore them, so this file
and `scripts/setup-branch-protection.sh` are their version control.

> [!NOTE]
> **Re-apply any time:** `scripts/setup-branch-protection.sh` (needs the GitHub
> CLI authenticated with admin on the repository; idempotent).

## `main` — the rule

| Setting                                       | Value            | Why                                                                                                                                                    |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Require a pull request before merging         | ✅               | Every change lands via a PR                                                                                                                            |
| — Required approvals                          | **0**            | One maintainer — the check is the gate, not a second reviewer                                                                                          |
| — Dismiss stale approvals / code-owner review | Off              | No reviewers, no `CODEOWNERS`                                                                                                                          |
| Require status checks to pass                 | ✅               | The merge gate                                                                                                                                         |
| — Required checks                             | **`local-gate`** | The one required context, posted by the pre-push gate and by `gate.yml`, both running the same registry (below)                                        |
| — Require branches up to date (`strict`)      | **Off**          | "On" forces a rebase and a full re-run every time `main` moves — churn with auto-merge at low concurrency. Turn on only if you run many concurrent PRs |
| Require linear history                        | ✅               | Pairs with squash-only merges; blocks accidental merge commits                                                                                         |
| Require conversation resolution               | Off              | No reviewers                                                                                                                                           |
| Require signed commits                        | Off              | Friction with no payoff for one maintainer                                                                                                             |
| Do not allow bypassing (`enforce_admins`)     | **On**           | Every change — documentation included — lands via a PR; there is no admin fast path                                                                    |
| Allow force pushes                            | **Off**          | Protect `main` history                                                                                                                                 |
| Allow deletions                               | **Off**          | Protect `main`                                                                                                                                         |

### The required check — `local-gate`, and only it

The merge gate is a **commit status** named `local-gate`, posted by two
producers that run the same tier from the same registry
(`scripts/ci/steps.mjs`):

- `scripts/ci/status.mjs`, after `pnpm gate` — normally via `.githooks/pre-push`,
  which runs the fast tier on the commit being pushed and posts once the push
  lands.
- `gate.yml`'s `Post the local-gate status` job, on a GitHub-hosted runner for
  every pull request into `main` ([D-157](../decisions/D-157.md)). A session
  with no laptop and no `gh` still gets the status onto its PR — say which run
  you actually saw, and never imply you posted one you did not.

A commit status attaches to **one commit**, so a green `local-gate` cannot
drift onto later work: push another commit and the PR is unmergeable until
that commit is certified too. It does not resist someone posting green by
hand, an accepted trade for a one-maintainer repository
([D-157](../decisions/D-157.md)).

> [!WARNING]
> **Require no other context.** A required check that does not run on every PR
> — a job that is skipped, dispatch-only or renamed — never posts success and
> strands every PR waiting for it. The heavy tier (`heavy.yml`) runs on every
> PR but is deliberately not required; promote reads its verdict instead.

### Code scanning — a ruleset, not a required check ([D-158](../decisions/D-158.md))

The script also turns on **private vulnerability reporting** (the route
`SECURITY.md` promises) and **CodeQL default setup**, then applies a ruleset
named `main: no new CodeQL alerts` with one `code_scanning` rule. It blocks a
merge that _introduces_ a CodeQL alert at severity `error`, or a security alert
at `high` or `critical`.

- It is **not** a required status context; `local-gate` stays the only one.
  The rule reads the alert database, so alerts already open on `main` do not
  block unrelated PRs, and no job name can strand a PR by moving.
- It has **no bypass actor**. To merge past a false positive, dismiss the alert
  on the Security tab with a reason.
- Never add a `codeql.yml` workflow. Tune the scan through the default setup's
  `query_suite` in the script.

## `production` — no blocking rule

`production` is written only by a promote fast-forward — `scripts/ci/promote.mjs`,
run by `promote-on-green.yml` when both runners certify a push to `main`
([D-199](../decisions/D-199.md)), or typed by the operator as `pnpm promote`. A
"require a pull request" or "require status checks" rule on `production` would
**reject that push and break deploys**. Production is gated upstream: promote
refuses to fast-forward unless Gate and Heavy are both green for the exact
commit, or `--force-gate` runs the full tier locally.

The script applies a **ruleset** (not classic protection) named
`production: fast-forward only, no delete`, with two rules:

- `non_fast_forward` — blocks force-pushes, so `production` history cannot be
  rewritten. A fast-forward is not a force-push, so the promote push passes.
- `deletion` — blocks dropping the branch.

It adds **no** required-PR, required-status or required-reviewer rule — any of
those would reject the promote fast-forward. Never add one.

### Only the owner ships production

Two more settings make shipping production the owner's alone. The script
applies both, and **`pnpm promote` refuses to run unless both hold**: it reads
them live through `scripts/ci/deploy-protection.mjs` before it moves anything,
and fails closed when it cannot read them.

- **The `production` environment requires the owner's approval** for every
  deploy run, with **admin bypass off** so a push made with the owner's own
  credentials still waits for a click, and **self-review allowed** because the
  one maintainer both pushes and approves. Only the `production` branch may use
  the environment, so its secrets reach no other ref.
- **A second ruleset, `production: only an admin moves it`**, holds a single
  `update` rule whose only bypass actor is the repository admin role. It does
  not reject the promote fast-forward, because whoever pushes it is the admin.
  It is **separate** because a bypass actor bypasses every rule in its ruleset:
  folded into the one above, it would let an admin force-push or delete
  `production`.

`apps/web/tests/config/production-access.test.ts` holds that what the script
applies is exactly what the promote check accepts.

### The runner's token — `PROMOTE_TOKEN`

`promote-on-green.yml` has to push as the admin (the ruleset above), and a push
made with `GITHUB_TOKEN` never triggers the deploy. So it uses a token acting
as the owner, made by hand once:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → new.
   Resource owner: the repository's owner. Repository access: **only this
   repository**.
2. Repository permissions: **Contents: read and write** (the fast-forward and
   the release), **Actions: read** (the runners' verdict), **Administration:
   read** (the rulesets and environment the protection check reads). Nothing
   else.
3. Store it as `PROMOTE_TOKEN` on the **`promote` environment**, never
   repository-wide. The script creates the environment and limits it to
   `main`; a repository-wide secret would reach every branch's workflows.

It can move `production`; nothing it can do skips the approval. Rotate it
before it expires, like `GCP_DEPLOY_KEY` ([`infra/gcp/README.md`](../../infra/gcp/README.md)).
An expired token makes the runner fail red rather than drift silently, and
`pnpm promote` from the laptop still works meanwhile.

## Paired repository settings (Settings → General → Pull Requests)

These are set by hand; the script does not apply them.

- **Allow squash merging** ✅, with **merge commits** and **rebase** off —
  squash becomes automatic and pairs with "require linear history".
- **Allow auto-merge** ✅ — it merges the moment the required check goes green.
  Since [D-199](../decisions/D-199.md) a merge starts a production release, so
  auto-merge does too; production still waits for the owner's approval.
- **Automatically delete head branches** ✅.
