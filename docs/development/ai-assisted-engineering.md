# AI-assisted engineering

**Most of this codebase was written by an AI agent under review.** This
document is the system built around that, and why each piece of it exists.

The premise is narrow and worth stating plainly: **an agent is a fast, capable
contributor with no memory of yesterday and no stake in tomorrow.** Everything
below follows from those two properties. Nothing here is about making an agent
smarter. It is about making the repository hard to get wrong, and making a wrong
answer fail loudly rather than merge.

---

## The four mechanisms

| Mechanism            | Answers                          | Lives in                                     |
| -------------------- | -------------------------------- | -------------------------------------------- |
| **Durable context**  | What must I know before I start? | [`CLAUDE.md`](../../CLAUDE.md) and `docs/`   |
| **Executable rules** | Did I break something?           | `scripts/ci/steps.mjs` — the gate            |
| **Bounded autonomy** | What am I allowed to do alone?   | `.claude/settings.json` and `.claude/hooks/` |
| **Delegation**       | How do I find what I don't know? | `.claude/agents/` and `.claude/skills/`      |

---

## Durable context: a budget, not a dump

`CLAUDE.md` is loaded into every session before anything else is read. Its cost
is not the disk it takes — it is the attention it displaces, and it is paid on
every turn of every session, in every worktree, forever.

A file that restates decision history and product rules is one an agent skims,
and those restatements drift from the documents that own them. So it holds
three things and nothing else:

- **Invariants** — the rules that cost real money or real correctness when
  broken, each stated once, each with a pointer to the document that owns the
  detail.
- **Commands** — what to run, and what a session must never run.
- **Traps** — the things that look right, compile, and are wrong.

Everything else is a link. **The document at the end of the link is the source
of truth, not a longer version of `CLAUDE.md`.** That is the same
"behaviour is defined once" rule the rest of this tree follows
([documentation standards](documentation.md)), applied to the file agents read
most.

**The budget is enforced.** `apps/web/tests/config/claude-md.test.ts` fails the
gate if `CLAUDE.md` grows past its line and word ceiling, and the ceiling is a
ratchet — lower it when the file gets tighter, never raise it to fit something
new. The same test proves every path and every `pnpm` command the file names
still exists. Agent context rots exactly the way documentation rots, and it does
more damage when it does: a stale documentation line is a link a reader shrugs
at; a stale `CLAUDE.md` line is an instruction something follows.

---

## Executable rules: the gate is the reviewer

A solo maintainer working with agents has no second pair of eyes. What replaces
one is not more careful reading — it is that **every rule worth having is a
program**.

`scripts/ci/steps.mjs` is the only definition of what "green" means, run
identically by the pre-push hook and by `gate.yml`. The full argument is in
[workflow.md](workflow.md); what belongs here is the consequence for agent work:

- **A rule stated only in prose holds exactly as long as attention does.** Every
  invariant in `CLAUDE.md` that could be made executable has been.
  `apps/web/tests/config/` is almost entirely this: tests that assert things
  about the repository rather than about the product — that the middleware is in
  the one place Next.js loads it from, that no workflow restates a gate step,
  that Supabase has not come back, that no `docs/…` path in the tree is dangling,
  that a number in the README still matches the tree.
- **A guard is written the moment prose proves insufficient, not before.** Each
  of those files opens with the incident that caused it. That is the standard
  for adding one: name the thing that actually went wrong.
- **When you retire a thing, retire its guard in the same change.** A guard
  whose premise has died does not announce it — it goes on making dead code look
  load-bearing.

The counterpart rule is in [D-140](../decisions/D-140.md): a guard that derives
its bound from the thing it is guarding certifies the violation it exists to
catch. Assert against something independent.

---

## Bounded autonomy: maximum useful freedom, minimum privilege

The goal is not a session that asks permission constantly. It is a session that
never has to ask about anything reversible, and cannot do the irreversible
things at all.

**Allowed without asking** (`permissions.allow` in `.claude/settings.json`) —
the checks (`pnpm gate --allow-dirty`, `typecheck`, `lint`, `test`, any
`pnpm --filter` script), formatting, the doc-count and leak checks,
`pnpm issue:check`, and the read-only status commands (`gate:lock`,
`release:status`, `local:status`). None of them can lose work.

**Asked every time** — `gh pr merge`, by a user-level rule that is the same in
every repository, so a merge happens only when the operator answers the prompt.
Nothing in this repository blocks it; a project-level deny would turn that
prompt into a refusal here alone.

**Denied outright** (`permissions.deny`) — `pnpm promote`, `gh release`, both
deploy scripts and the `infra/gcp/` operator scripts, writing `gcloud` commands
(`run deploy`, `secrets`, service-account keys), anything matching
`migrate:prod`, `infisical`, `neon`, `psql`, the browser suite
(`pnpm test:e2e`), and reads of the credential-bearing files. Each of these
moves real money, touches shared or production data, hands out live
credentials, or holds a shared resource.

**Two hooks cover what a permission pattern cannot:**

- `.claude/hooks/guard-bash.sh` (PreToolUse) sees the whole command line, so
  it catches the shapes prefix matching misses — a gate bypass in an
  environment variable or a flag in the middle of a push, a force-push, a read
  of a credential file through `cat`. These are precisely what a model reaches
  for when a push looks stuck, and a push that looks stuck is usually queuing
  on the [machine lock](workflow.md#one-heavy-job-at-a-time). It also warns
  (without blocking) on a bare `git stash`, because the stash stack is shared
  across every worktree on the machine.
- `.claude/hooks/format-edited.sh` runs prettier on the single file that just
  changed. `format` is the first step of the gate and the cheapest to fail, but
  it fails at push time — minutes after the edit, costing a full re-run and a
  second commit. A few hundred milliseconds at write time removes the class.

- `.claude/hooks/session-start.sh` (SessionStart) runs `pnpm install` only
  when the lockfile or workspace manifest changed since the last install.

**The operator-only rule exists three times on purpose**: as a sentence in
`CLAUDE.md`, as deny rules, and in the Bash hook.
`apps/web/tests/config/claude-md.test.ts` fails if `CLAUDE.md` stops naming an
operator-only command or `settings.json` stops denying it, and
`apps/web/tests/config/agent-guardrails.test.ts` executes the hook against real
command lines. A rule about irreversible actions should not have a single
point of failure, least of all a model's attention.

---

## Delegation: read less, not more

**`.claude/agents/decision-scout.md`** answers one question — _what has already
been decided about this, and what does it forbid?_ — by reading
`docs/decisions/` in its own context and returning a few lines.

This is the direct consequence of keeping `CLAUDE.md` small: it cannot inline
the decision log's conclusions. A subagent is better than the main session here
for a structural reason: the answer is short and the reading is long, so the
reading belongs somewhere that is thrown away afterwards.

The most expensive mistake available in this repository is not a bug — it is
re-deriving a decision that was already made, measured and reversed. Putting
back the `application_fee_amount` [D-143](../decisions/D-143.md) removed, or a
free-form payee field [D-145](../decisions/D-145.md) rules out, looks like an
improvement from inside the diff.

**`.claude/skills/pr/SKILL.md`** (`/pr`) is the other half: the walk from a
finished change to an open, green pull request. It stops there, deliberately —
opening a pull request and shipping one are different decisions, and a command
that quietly did both would be making the second on the operator's behalf.

**`.claude/skills/issue/SKILL.md`** (`/issue`) files the work a session finds
but does not fix. [D-164](../decisions/D-164.md) put that work in Issues and
admitted nothing enforces an issue's shape; the skill is the checklist in the
meantime — search open and closed issues for a duplicate, send anything
exploitable to [SECURITY.md](../../SECURITY.md) instead, write a **Done when**
line, and file only after the user approves the draft, because the repository
is public and filing publishes. The parts a machine does better run as
`pnpm issue:check` (`scripts/issue-check.mjs`), which the skill calls on every
draft. It lints the title and the end state, rejects labels that do not exist,
runs the gate's own leak detectors over the text, and ranks the closest open and
closed issues. `apps/web/tests/config/agent-skills.test.ts` fails if the skill
stops calling the checker or loses its approval, security or never-close rules.

**What was deliberately not built.** No skill for writing a decision record —
`docs/decisions/_template.md` and its README already say how, and a skill
restating them would be a second source of truth. No skill for migrations —
[data-model.md](../architecture/data-model.md) and
`apps/web/prisma/migrations/README.md` own that. No review agents for
TypeScript, Next.js or security: the gate already runs `tsc`, ESLint, a
credential scan, a leak check and a dependency audit deterministically, and an agent that
re-reads the diff for the same defects is slower, less reliable, and produces
findings nothing can act on. **An agent is worth adding when it reads more than
it returns. Otherwise it is decoration.**

---

## The shape of a session

The configuration is meant to produce this without anyone typing it:

```
Understand  →  read CLAUDE.md; follow the one link the task points at;
               ask decision-scout what is already settled
Plan        →  identify the risk tier; find the feature document that owns
               the behaviour being changed
Change      →  small, in the folder that already owns the domain
Verify      →  tests ship with the change; pnpm gate --allow-dirty
Review      →  /pr — commit, push (the gate runs), open the PR, stop
```

The step that is easiest to skip is **Verify**, and it is the one made
non-optional: the pre-push hook runs the gate whether or not anybody remembered
to, and the bypasses are blocked rather than discouraged. That is the whole
design in one sentence — **the checks that matter do not depend on being
remembered.**

---

## Related

- [`CLAUDE.md`](../../CLAUDE.md) — the rule set itself
- [Workflow](workflow.md) — the gate, the pull request, the promote
- [Testing](testing.md) — the test layers and the guard tests
- [Documentation standards](documentation.md) — where a document goes, and why
  behaviour is defined once
- [Decision records](../decisions/README.md) — current policy, not history
