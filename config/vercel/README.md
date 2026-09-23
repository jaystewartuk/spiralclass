# Vercel project configuration

One file per environment, passed to the CLI with `--local-config` by
[`scripts/vercel-deploy.sh`](../../scripts/vercel-deploy.sh). Today there is one:
`production.json`.

**This directory exists because the root `vercel.json` must not.** That file was
deleted by [D-164](../../docs/decisions/D-164.md) and
`apps/web/tests/config/decommissioned-platforms.test.ts` still asserts it cannot
come back — not as a leftover of the teardown, but because Vercel reads a root
`vercel.json` automatically, which is how a repository acquires a deploy trigger
nobody typed. Keeping the config here means the CLI is the only thing that can
find it, and the CLI only runs when something calls it.
[D-177](../../docs/decisions/D-177.md) is the record.

JSON carries no comments, so the three non-obvious values are explained here and
each is pinned by `apps/web/tests/config/vercel-deploy.test.ts` — a sentence in
this file is not what holds them.

| Key                     | Why it is what it is                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `regions: ["cle1"]`     | Cleveland, `us-east-2` — the region **D-150 measured**. Its whole argument was 58 ms from Querétaro to Neon against 12 ms from Fly `ord`, times twenty-eight round trips on a database-heavy page. A function in the wrong region re-introduces exactly that latency, silently and with nothing failing. ⚠️ See below. |
| `git.deploymentEnabled` | `false`. The second half of "no root `vercel.json`": even if someone connects the repository in the dashboard, no branch push deploys. Every deploy goes through Actions ([D-150](../../docs/decisions/D-150.md)'s addendum, [D-157](../../docs/decisions/D-157.md)).                                                  |
| `buildCommand`          | `pnpm --filter spiralclass-web build` — the workspace's **own** build script, not a retyped `next build`. `apps/web/package.json` owns what building means, here as in the Dockerfile.                                                                                                                                 |

⚠️ **`cle1` is an unverified premise, deliberately recorded as one.** D-150 says
Neon production is "in Ohio"; the project's region is not committed anywhere in
this tree (the publication sweep removed the project identifier — see D-158), so
nobody can check it from here. Confirm it with `neonctl projects list` before
this target ever takes the domain. If the answer is not `us-east-2`, change this
value and the test that pins it in the same commit.

## What is not here

**No environment variables.** The project's env store holds the failover's
runtime environment, but only as a copy derived from the places Cloud Run's
comes from, written by two callers that mark every entry they own:

- `infra/infisical/push-vercel-env.sh` (operator) pushes Infisical
  `production` `/` and the production R2 credentials, as `sensitive`.
- `scripts/vercel-deploy.sh` (every release) syncs
  `config/env/production.runtime.env` from the commit, and refuses to deploy
  when a `__LOCAL__` key was never pushed or a dashboard value nobody owns
  would shadow a committed one.

Nothing is to be set in the dashboard by hand — the deploy refuses on it. The
build sees none of the store either: the deploy replaces what `vercel pull`
brings down with `config/env/production.build.env`'s values, so the dashboard
cannot win a disagreement it should not be having. `scripts/vercel-env.mjs`'s
header is the full account.
