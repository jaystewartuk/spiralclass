# Contributing to SpiralClass

## If you are not the maintainer

This is a solo-maintained production system, published as open source under the
[AGPL-3.0](./LICENSE). **Read it, run it, fork it, learn from it** — that is what
publishing it is for.

> [!IMPORTANT]
> **Code contributions are not being merged at the moment**, and that is a
> deliberate position rather than an oversight.
>
> This is a live system that takes real money and holds real people's data,
> maintained by one person with no legal or security function behind them. The
> honest reason is about rights, not about quality: with no contributor
> agreement in place, accepting outside code would make relicensing this
> project later impossible without tracking down every contributor for their
> consent — and it is not fair to accept someone's evening of work into that
> position without saying so first.
>
> **A fork is the right answer**, and the AGPL guarantees it stays open.

**What is very welcome**, and gets read:

- **Bug reports and reproductions.** Open an issue.
- **Security reports** — privately, never in an issue or a pull request. See
  [`SECURITY.md`](./SECURITY.md).
- **Questions about how something works.** An issue is the channel; there is no
  Discussions tab and there is not going to be one.

**If that position changes**, the terms are settled in advance so nobody has to
guess at them: contributions would be accepted under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/), signed
off per commit (`git commit -s`), and licensed inbound under **AGPL-3.0-only** —
the same licence as the project, with no additional grant asked for and none
taken.

Working in a fork, `pnpm gate --allow-dirty` gives you the same verdict the
maintainer's pre-push hook and the pull-request workflow produce, without
needing either.

## Getting set up

**[`docs/development/setup.md`](./docs/development/setup.md)** is the full
version: prerequisites, the database, seed data, which services you actually
need, and what to do when something does not start.

```bash
pnpm setup && pnpm dev
```

One command from a fresh clone to a running app with seeded data and no
credentials.

## The change workflow, in sixty seconds

```
branch → implement + tests → git push (the pre-push hook runs pnpm gate)
  → PR into main → local-gate status green → squash-merge
  → pnpm ship:preview → verify on preview → pnpm promote → production
```

- **`main` is the trunk.** Every change — docs included — lands via a pull
  request. There is no direct-push exception.
- **The gate is one program, run in two places.** `scripts/ci/steps.mjs` is the
  only definition of what "green" means. `.githooks/pre-push` runs it on every
  push and posts the **`local-gate`** commit status branch protection requires;
  `gate.yml` runs the same registry on every pull request and posts the same
  status, so a laptop-less day is not a stranded PR. The two producers cannot
  disagree about anything but timing.
- **The heavy suites run on runners.** Mutation, real-database integration and
  the browser suites are three parallel jobs in `heavy.yml`, on every pull
  request _and_ every push to `main`. The run against `main` is the one that
  catches a combination broken though every PR in it was green alone. They are
  deliberately **not** a required check — read them before merging anyway.
- **Merging to `main` deploys nothing today.** Preview's push trigger is
  suspended while preview moves to a new host; `pnpm ship:preview` is how
  preview gets fresh. Production is only ever `pnpm promote`.
- **Tests ship with the change.** A change is not done until it ships with tests
  covering the new behaviour and the regression it fixes. There is one client,
  so that means web tests.
- **Branch names carry intent:** `feat/` · `fix/` · `hotfix/` · `chore/` ·
  `refactor/` · `docs/`.

Full detail, including the escape hatches and what each costs:
**[`docs/development/workflow.md`](./docs/development/workflow.md)**.

## Rules that bind humans as much as agents

[`CLAUDE.md`](./CLAUDE.md) at the repository root is the non-negotiable rule set
for automated sessions — risk tiers, tests-required, migration discipline, the
payments and subscriptions invariants. It binds a human making the same change
just as much. Read it before touching payments, auth, migrations or
infrastructure.

It is deliberately short, and it is held to the tree: every path and command it
names must exist, and it must stay inside a line budget the gate enforces. The
system around it — the permission model, the hooks that block a gate bypass, the
one subagent, and what was deliberately **not** built — is described in
[`docs/development/ai-assisted-engineering.md`](./docs/development/ai-assisted-engineering.md).

## Issues, backlog and documentation

- **This repository holds no backlog** ([D-110](./docs/decisions/D-110.md)).
  Open work lives on the maintainer's private board. Do not add `TODO.md`-style
  files, and do not open GitHub issues for your own work — Issues are for
  machine-filed reports, anything a PR closes with `Closes #N`, and reports and
  questions from outside.
- New documentation goes where
  [`docs/development/documentation.md`](./docs/development/documentation.md)
  says; [`docs/README.md`](./docs/README.md) is the map. Superseded documents are
  deleted, not archived.
- A change significant enough to set or reverse policy needs a decision record
  in [`docs/decisions/`](./docs/decisions/README.md) — read the relevant record
  before reversing anything it constrains.

## Where things live

| For                       | Read                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Getting it running        | [`docs/development/setup.md`](./docs/development/setup.md)                                     |
| Running the tests         | [`docs/development/testing.md`](./docs/development/testing.md)                                 |
| The workflow, in full     | [`docs/development/workflow.md`](./docs/development/workflow.md)                               |
| How the system is built   | [`docs/architecture/overview.md`](./docs/architecture/overview.md)                             |
| Why it is built that way  | [`docs/decisions/`](./docs/decisions/README.md)                                                |
| Operating it              | [`docs/deployment/`](./docs/deployment/README.md)                                              |
| Reporting a vulnerability | [`SECURITY.md`](./SECURITY.md)                                                                 |
| Working on it with agents | [`docs/development/ai-assisted-engineering.md`](./docs/development/ai-assisted-engineering.md) |
