---
name: pr
description: Take the work in this worktree from done to a PR that can merge — commit it in the house style, name the branch, push (which runs the gate), open the PR, confirm the local-gate status. Use when the user says they're done, asks to open/raise a PR, to commit and push, or to "ship" work from a session. Stops at the open PR; it never merges, deploys or promotes.
---

# /pr

The **front half** of shipping. Ends at "PR #N is open and green" — deliberately.

`scripts/open-pr.sh` does the mechanical half. Your job is the half a script
would do badly: deciding what to commit, and writing the commit message and PR
body.

## Why this stops at the PR

The back half is `gh pr merge --squash --delete-branch`, and then
`pnpm promote` when production is actually wanted.

There used to be a `/ship-pr` skill that batched all of that, because the heavy
suites could only run on the operator's laptop and needed to run once rather
than once per branch. [D-162](../../../docs/decisions/D-162.md) deleted it:
`heavy.yml` now runs those suites on a runner, on every PR **and** on every push
to `main`, so there is nothing left to batch and nothing to remember to run.

**Never merge, deploy or promote from this skill anyway.** Not for contention
any more — because opening a PR and shipping one are different decisions, and a
command that quietly did both would be making the second one on the user's
behalf. Timing is theirs (CLAUDE.md: no risky-path merges during lesson hours).

What to tell the user when the PR is open: the heavy suites are running on it,
they take about 17 minutes, and they do not block the merge button — so somebody
has to look at them rather than wait to be stopped.

## What you do, in order

1. **Review the diff.** `git status` and `git diff` (plus `git diff --staged`).
   Understand every change; drop anything stray you didn't intend.
2. **Check the work is tested.** CLAUDE.md: a change isn't done until it ships
   with tests covering the new behaviour and the regression it fixes. If it
   doesn't, write them now — not after the PR is open.
3. **Commit**, in this repo's style (below), including the attribution trailers
   this session was given.
4. **Write the PR body** to a scratch file, following
   `.github/pull_request_template.md` — Summary, Test plan, and the security
   checklist with each item marked `[x]` or `[N/A]`. An unchecked box is a
   question for the reviewer, and there is no reviewer but the operator.
5. **Run the script:**

   ```bash
   bash scripts/open-pr.sh --branch <topic-name> --title "<title>" --body-file <path>
   ```

   Use a **long timeout** and stream the output. The push runs the gate and
   **queues on the machine-wide lock** if another session is gating, so a run
   that looks stuck is usually waiting — it says so. Do not kill it, do not
   retry it in another shell, and never reach for `SKIP_GATE=1` or
   `--no-verify`.

6. **Report**: the PR number and URL, and whether `local-gate` came back green.

## House style for the title and message

Commit subjects and PR titles here are **a full sentence naming the problem the
change fixes, in past tense, from the user's side** — not a category prefix and
not an imperative. Look at recent history before writing one:

- _The class list said everything twice and could not say what was next_
- _A teacher could not tell what her communities page was asking her_
- _The checkout's Stripe failures logged "[object Object]" and sent Sentry no error_

Not `fix: class list dedupe`. The subject should make sense to someone who has
not seen the diff. The body says **why**, and names the cause; the diff is the
source of truth for what.

Branch names are plain kebab topics (`refresh-visual-baselines`,
`per-package-custom-price`). Pass `--branch` — left to itself the script derives
one from the commit subject, and the harness's `worktree-<name>` default says
nothing about the change.

## Flags

| Flag                      | Effect                                                       |
| ------------------------- | ------------------------------------------------------------ |
| `--branch <name>`         | Name the branch (renames the current one, or cuts a new one) |
| `--title` / `--body-file` | The PR title and body                                        |
| `--rebase`                | Rebase onto fresh `origin/main` before pushing               |
| `--draft`                 | Open it as a draft                                           |

Re-running on a branch that already has an open PR is the normal way to add a
commit: the push updates it and the script reports the existing number.

## It fails closed

- Refuses a dirty tree, `main`, `production`, a branch with nothing ahead of
  `origin/main`, and a `--branch` that would overwrite someone else's remote
  branch.
- Never passes a gate bypass. If the push fails, the gate is red — **fix it**,
  report what failed, and do not push again with a bypass flag.
- If `local-gate` comes back red or never posts, say so plainly. The PR cannot
  merge without it and that is the point.

## When NOT to use this

- The work isn't finished or isn't tested. Opening a PR doesn't make it so.
- The user wants it in production **now** — that's `/pr`, then `gh pr merge`,
  then `pnpm promote`, and the timing call (CLAUDE.md: no risky-path merges
  during lesson hours) is theirs, not yours.
