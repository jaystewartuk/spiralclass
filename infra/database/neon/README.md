# Neon — provisioning + migration (D-49 provider swap)

This directory is the "future `neon/` module" the original `database/supabase`
Tofu module's README named a spot for, back when D-49 first planned the
provider swap — that module (and Supabase itself) has since been fully
retired (D-89) and removed from the repo. This one is **not** an OpenTofu
module (no stable/needed Terraform provider work has been done here) — Neon
project creation is a manual, interactive step (console sign-in, no API key
wired into this repo yet), so this is an operator runbook, not IaC.

## The short version

**Neon needs no special handling at all.** `apps/web/prisma/migrations/` holds
two migrations with zero Supabase-specific SQL — a generated schema baseline
and the hand-authored Postgres invariants beside it ([D-168](../../../docs/decisions/D-168.md);
the Supabase-era RLS, `auth.uid()`/`auth.users`, `anon`/`authenticated` grants
and the Realtime publication went at the 2026-07-13 squash, D-70). So a fresh
Neon database just runs `prisma migrate deploy` like any other environment —
no shim, no `db push` workaround, no bootstrap script.

```sh
# 1. Point env at Neon (pooled DATABASE_URL, direct DIRECT_URL — see below).
# 2. Normal migrate deploy. Works exactly like it does everywhere else now.
pnpm --filter spiralclass-web exec prisma migrate deploy
```

Tested, not assumed: applied against a throwaway `postgres:16` container via
Prisma's real `migrate deploy` and exercised functionally — buffer-derivation
trigger, both booking-overlap exclusion constraints, the `overrides`
append-only trigger, the partial unique indexes and a dozen CHECK constraints
all behave correctly on a database built from these two files alone. Prisma's
own P3005 safety check refuses to run a baseline against a non-empty schema,
so a mis-sequenced adoption fails loudly rather than corrupting anything.

## Provisioning a Neon project

1. **Create the project** at [console.neon.tech](https://console.neon.tech).
   Region: `aws-us-east-2` (Ohio) — closest Neon-supported region to Fly's
   `dfw` (Dallas), which is what actually matters for latency (the app talks
   to the DB on every request; neither platform has a Mexico region).
2. **Get two connection strings** from the project's Connection Details panel:
   - **Pooled** (has `-pooler` in the hostname) → `DATABASE_URL`.
   - **Direct** (no pooler) → `DIRECT_URL`. Prisma's migration engine needs
     the direct one; the app's runtime queries use the pooled one (same split
     as Supabase's Transaction-mode pooler vs. direct connection).
   - Neon connection strings already include `?sslmode=require` — keep that.

## Fresh database (disposable data — e.g. preview)

```sh
pnpm --filter spiralclass-web exec prisma migrate deploy
pnpm --filter spiralclass-web seed:preview   # or seed:local, etc.
```

## Already-has-data database (adopting the baseline without re-running it)

Only relevant for a database whose `_prisma_migrations` was written by an
older, different history. Skip this entirely for any brand-new Neon project —
just run `migrate deploy` normally.

```sh
prisma migrate resolve --applied 20260906120000_schema_baseline
prisma migrate resolve --applied 20260906120100_database_invariants
prisma migrate status   # confirm: "Database schema is up to date!"
```

Verify the database really does match before resolving, and understand what
that verification does and does not cover:
[`apps/web/prisma/migrations/README.md`](../../../apps/web/prisma/migrations/README.md).

## Agent access

Interactive agent sessions (Claude Code) reach Neon through the **Neon CLI**
(`neonctl`) and `psql`. There is no MCP server and no `.mcp.json` in this repo —
that setup was removed on 2026-08-31 in favour of the CLI, which covers the same
ground with one credential instead of two and no soft-failing `${VAR}` expansion
to get wrong.

### Authenticating

`neonctl auth` once, interactively; the credential lands in
`~/.config/neonctl/credentials.json` and is machine-local, never in the repo.
`NEON_API_KEY` in the environment overrides it if you need a scoped key for a
one-off.

The org has to be named on every non-interactive call or the CLI stops to ask:

```sh
neonctl projects list --org-id "$NEON_ORG_ID" --output json
```

The two projects:

| Project                  | Id                            | Notes                                                          |
| ------------------------ | ----------------------------- | -------------------------------------------------------------- |
| `agendaprofe-preview`    | _see `neonctl projects list`_ | disposable, reseedable via `seed:preview` — nothing to protect |
| `agendaprofe-production` | _see `neonctl projects list`_ | real student data; read-only for agents, see below             |

### Running SQL — `neonctl` cannot, `psql` can

`neonctl` is a **control-plane** tool: projects, branches, databases, roles,
connection strings, snapshots, operations. It has no SQL-exec subcommand. To run
a query you take a connection string from it and hand that to `psql`:

```sh
psql "$(neonctl connection-string production --project-id "$NEON_PROJECT_ID")"
```

**There is no Neon API key in Infisical any more, and none should go back.**
`neon-checkpoint.sh` needed a third, separate `NEON_API_KEY` until 2026-08-31;
it now authenticates with the credential `neonctl auth` stores on the deploy
machine, same as everything else here. If a scoped key is ever reintroduced,
keep it out of Infisical's `preview`/`production` environments —
`push-fly-secrets.sh` bulk-imports a whole environment into `fly secrets`, and
handing the running app a control-plane credential buys nothing. `infra` is the
right home precisely because it is never synced to Fly.

### Neon is left at its defaults, on purpose (2026-08-31)

**No read-only role, no protected branches, no custom Postgres roles.** An
agent session on the dev machine has owner-level read/write on production,
exactly as the operator does. State it plainly, because three earlier versions
of this file implied a restriction that was never in place.

Two mitigations were designed and both were dropped, each for a reason worth
keeping so neither is re-derived:

- **A `?readonly=true` MCP endpoint.** Gone with the MCP servers. It was never
  more than a policy flag on one tool surface — a session holding a
  full-privilege `DATABASE_URL` routed straight around it.
- **A read-only `claude_ro` Postgres role** (`claude-readonly-role.sql`,
  deleted 2026-08-31 having never been run — `pg_roles` on the production
  branch held only `cloud_admin`, `neon_service`, `neon_superuser` and
  `neondb_owner`). It fails for the same reason its own header warned about:
  the session you would hand it to can run
  `neonctl connection-string production` and get the owner string in one
  command. A read-only role only constrains an agent that cannot mint the
  owner credential, and `neonctl` is authenticated machine-wide. It would have
  added a credential that reads every production row while enforcing nothing.

**What actually protects production**, and what to rely on:

1. **The agent harness's permission layer** — the thing that prompts on, or
   refuses, a destructive command. This is the real control, and unlike the two
   above it is not routed around by holding a different connection string.
2. **Neon PITR plus the D-95 pre-migration checkpoint branch**
   (`infra/database/scripts/neon-rollback.sh`) — recovery, for when something
   does get through.

If this posture ever needs to change, the honest fix is to stop the machine
holding an authenticated `neonctl` at all, not to add another role beneath one.

### Writes against production-shaped data go through a branch

When something genuinely needs to mutate prod-shaped data — rehearsing a
migration, reproducing a data bug — do not lift the read-only restriction.
Create a Neon branch off `production` and work there. It is copy-on-write
against the parent's WAL, so it costs seconds and diverging bytes only; this is
the same mechanism `neon-checkpoint.sh` already relies on.

**⚠️ Name agent-created branches with something other than the `pre-deploy-`
prefix, and delete them when done.** The production project has a per-project
branch ceiling (10, `owner.branches_limit` on `neonctl api /projects/<id>`),
and `neon-checkpoint.sh` prunes on exactly that prefix (`--keep 5` by default)
on the assumption that deploy checkpoints are the only thing consuming slots.
Ad-hoc branches under that prefix would be swept by the pruner; ad-hoc branches
under _any_ prefix eat headroom the checkpoint needs — the script counts them
and now refuses up front if retention no longer fits under the ceiling, so a
forgotten rehearsal branch turns into a legible error before the deploy rather
than a "branches limit exceeded" during it.
Exhausting the ceiling is not a soft failure — the checkpoint is the first step
of the production deploy job and D-95 refuses to migrate without one, so it
soft-locks production deploys entirely. That happened on 2026-07-29 (fixed in
`fea9542c` by pruning before creating); don't recreate it from the other
direction.

### Protected branches — DECIDED AGAINST (2026-08-31). Don't re-raise it.

**We are not buying a Neon plan for this, and `production` is deliberately
unprotected.** This is a decision, not a pending task — an earlier version of
this section read as an instruction ("do this before…") while being
unachievable, which is how it sat undone for weeks looking like an oversight.

Measured 2026-08-31: the account is `free_v3` (`neonctl api /projects/<id>` →
`project.owner.subscription_type`), and Free allows **zero** protected
branches. `production` is `"protected": false` on both projects; a `PATCH`
setting it returns _"You have reached the maximum number of protected branches
for your current plan."_ Launch allows 2, Scale 5.

**The risk this accepts:** nothing on Neon's side stops the production branch
being deleted or reset by whatever holds a management credential. The
compensating control is Neon's PITR plus the D-95 pre-migration checkpoint,
which is what actually recovers the data if it happens — recovery rather than
prevention, deliberately. See "Neon is left at its defaults" above for why the
preventive options were dropped instead of stacked.

The rationale below is retained for whoever revisits this if the plan ever
changes. Neon has
**no read-only management API key tier** — personal, organization and
project-scoped are the three, and project-scoped carries **Editor**: read
_and_ modify. So whatever `neonctl` is authenticated as can create and delete
branches, and since the CLI replaced the `?readonly=true` MCP endpoint there is
no longer even a tool-layer flag suggesting otherwise. The branch-anchored
`create-credential` API is not an alternative — its scopes are
`storage:read`/`storage:write`/`ai_gateway:invoke`/`functions:invoke`, none of
which touch the database or the management plane, and it is Private Beta.

Protecting the branch is the mitigation that doesn't depend on the caller:
it is enforced by Neon on the resource, so it holds regardless of which key is
used or what flags are passed. It gives you:

- `production` cannot be deleted, and cannot be reset from its parent
- the project cannot be deleted while a protected branch exists
- its computes cannot be deleted, and it is exempt from inactivity archiving
- branches cut from it get auto-generated Postgres role passwords, so a child
  branch doesn't inherit production's role password
- optional IP restrictions, if combined with Neon's IP Allow

Two things it does **not** do. It doesn't stop writes to data inside the
branch — protection guards the branch as a resource, not its rows, so it would
never have been a substitute for the read-only role we decided against. And it
doesn't interfere with checkpoint pruning: `pre-deploy-*` branches aren't
protected, so `neon-checkpoint.sh` keeps deleting them normally. Only
`production` itself becomes undeletable, which is the point.

One thing to re-check before enabling it, if the plan is ever upgraded: the
D-95 rollback path is `neonctl branches restore production <source>`
(`infra/database/scripts/neon-rollback.sh`), and protection blocks `branches
reset`. Those are different operations, but confirm `restore` still works on a
protected branch — cheaply, by protecting a throwaway branch on the **preview**
project and restoring it — before relying on the rollback net in an incident.

## Nothing stays on Supabase any more (D-89)

Storage was already on R2 by default before this squash
(`apps/web/src/lib/storage/provider.ts`); the Supabase-storage rollback
path that used to sit alongside it (kept for a manual-rollback window) was
removed once that soak period completed. `apps/web/src/lib/env.ts` has the
current, authoritative note on this — there is no `@supabase/supabase-js`
dependency, no `SUPABASE_*`/`NEXT_PUBLIC_SUPABASE_*` env var, and no
Supabase code path left anywhere in the app. See
`docs/decisions/D-89.md` for the full decommission record.

## Ongoing operational note

Every future schema change lands in `schema.prisma` + a normal `prisma
migrate dev`-generated migration, same as always — there's no more special
Neon path to remember. The portable-baseline squash was a one-time event, not
an ongoing discipline.
