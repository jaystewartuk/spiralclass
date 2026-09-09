# AI-assisted engineering

**Most of this codebase was written by an AI agent under review.** That is
stated in the README as a fact about provenance; this document is the part that
matters more — the system built around it, and why each piece of that system
exists.

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

It was 885 lines. Most of that was decision history that `docs/decisions/`
already owned and product rules that `docs/features/` already owned, restated
where they could drift. A file that long is one an agent skims, which is the
same as one nobody wrote.

So it holds three things and nothing else:

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
  invariant in `CLAUDE.md` that could be made executable has been. The
  `tests/config/` directory is almost entirely this: 32 files that assert things
  about the repository rather than about the product — that the middleware is in
  the one place Next.js loads it from, that no workflow restates a gate step,
  that Supabase has not come back, that no `docs/…` path in the tree is dangling,
  that a number in the README still matches the tree.
- **A guard is written the moment prose proves insufficient, not before.** Each
  of those files opens with the incident that caused it. That is the standard
  for adding one: name the thing that actually went wrong.
- **When you retire a thing, retire its guard in the same change.** A guard
  whose premise has died does not announce it — it goes on making dead code look
  load-bearing. A route tree here outlived its client by a month for exactly
  this reason.

The counterpart rule is in [D-140](../decisions/D-140.md): a guard that derives
its bound from the thing it is guarding certifies the violation it exists to
catch. Assert against something independent.

---

## Bounded autonomy: maximum useful freedom, minimum privilege

The goal is not a session that asks permission constantly. It is a session that
never has to ask about anything reversible, and cannot do the irreversible
things at all.

**Allowed without asking** — reading anything in the tree, searching it, running
any check (`pnpm gate --allow-dirty`, `typecheck`, `lint`, `test`, a single test
file), formatting, and read-only `git` and `gh`. These are the operations a
session performs dozens of times an hour and none of them can lose work.

**Denied outright** — `pnpm promote`, `gh pr merge`, both deploy scripts,
anything matching `migrate:prod`, `infisical`, force-pushes, hard resets, and
reads of the credential-bearing files. Every one of these either moves real
money, touches production data, or hands out live credentials, and none has an
undo worth the name.

**Two hooks cover what a permission pattern cannot:**

- `.claude/hooks/guard-bash.sh` sees the whole command line, so it catches the
  shapes prefix matching misses — `SKIP_GATE=1 git push`, `git push
--no-verify`, `cat config/env/production.local.env`. These are precisely what
  a model reaches for when a push looks stuck, and on this machine a push that
  looks stuck is usually queuing on the [machine lock](workflow.md). It also
  warns (without blocking) on a bare `git stash`, because the stash stack is
  shared across every worktree on the machine.
- `.claude/hooks/format-edited.sh` runs prettier on the single file that just
  changed. `format` is the first step of the gate and the cheapest to fail, but
  it fails at push time — minutes after the edit, costing a full re-run and a
  second commit. A few hundred milliseconds at write time removes the class.

**The rule about merging exists three times on purpose**: as a sentence in
`CLAUDE.md`, as a deny rule, and as a hook — and
`apps/web/tests/config/claude-md.test.ts` fails if the three drift apart. A rule
about irreversible actions should not have a single point of failure, least of
all a model's attention.

---

## Delegation: read less, not more

**`.claude/agents/decision-scout.md`** answers one question — _what has already
been decided about this, and what does it forbid?_ — by reading
`docs/decisions/` in its own context and returning a few lines.

This is the direct consequence of shrinking `CLAUDE.md`. The old file tried to
inline the log's conclusions, which is why it was 885 lines, and it still could
not hold 125 records. A subagent is better than the main session here for a
structural reason rather than a clever one: the answer is short and the reading
is long, so the reading belongs somewhere that is thrown away afterwards.

The most expensive mistake available in this repository is not a bug — it is
re-deriving a decision that was already made, measured and reversed. Putting
back the `application_fee_amount` [D-143](../decisions/D-143.md) removed, or the
payout instrument [D-145](../decisions/D-145.md) deleted, looks like an
improvement from inside the diff.

**`.claude/skills/pr/SKILL.md`** (`/pr`) is the other half: the walk from a
finished change to an open, green pull request. It stops there, deliberately —
opening a pull request and shipping one are different decisions, and a command
that quietly did both would be making the second on the operator's behalf.

**What was deliberately not built.** No skill for writing a decision record —
`docs/decisions/_template.md` and its README already say how, and a skill
restating them would be a second source of truth. No skill for migrations —
[data-model.md](../architecture/data-model.md) and
`apps/web/prisma/migrations/README.md` own that. No review agents for
TypeScript, Next.js or security: the gate already runs `tsc`, ESLint, two
credential scanners and a dependency audit deterministically, and an agent that
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
- [Testing](testing.md) — the five test layers and the guard tests
- [Documentation standards](documentation.md) — where a document goes, and why
  behaviour is defined once
- [Decision records](../decisions/README.md) — current policy, not history
