# DB region-migration runbook (D-49)

How to stand up a new-region Postgres and move data into it, as a reproducible
pipeline instead of a dashboard one-way door. This is the **operator procedure**
for [D-49](../../docs/decisions/D-49.md)'s three layers; run it only
when the [D-48](../../docs/decisions/D-48.md) trigger fires (first EU
user / DPA request / adverse legal read). Nothing here runs automatically.

The three layers are **decoupled on purpose** — each is independently
reproducible, and every one is provider-neutral except layer 1's provisioner:

| Layer         | "…"                                   | Tool                                                                                   | Where                                 |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| 1 · provision | a Postgres exists in region X         | manual, via console (`neon/`) — the original `supabase/` Tofu module was retired, D-89 | `neon/`                               |
| 2 · schema    | its structure is identical everywhere | Prisma `migrate deploy`, region-parameterized                                          | `apps/web/scripts/migrate-regions.ts` |
| 3 · data      | rows get in / move between regions    | `pg_dump`/`pg_restore` + logical replication                                           | `scripts/` (this dir)                 |

**Golden rule (D-49):** layer 3 uses **Postgres-native logical tools only** —
never a provider's proprietary migration/CDC service (AWS DMS et al.), which
re-locks you. Every script here takes plain connection strings and works between
any two real Postgres.

## Prerequisites

- `pg_dump` / `pg_restore` / `psql` whose **major version ≥ the source's**.
  Don't pin a major from memory — it rots the moment the managed provider
  upgrades (this doc said "Postgres 17" until 2026-07-20, by which point Neon
  had moved prod to 18 and a pinned client-17 could no longer dump it at all).
  Check the server, then install the newest client, which can dump any older
  server:
  ```sh
  psql "$SOURCE_DATABASE_URL" -tAc 'SHOW server_version'   # what you must match or beat
  sudo apt-get install -y postgresql-client                # newest PGDG major
  ```
  `backup-prod-db.yml` does exactly this, and hard-fails with a precise message
  if the newest available client is still behind the server.
- Connection URLs for source (current prod) and target. Pass them as args or via
  `SOURCE_DATABASE_URL` / `TARGET_DATABASE_URL`. **Treat them as secrets** — the
  scripts never log them (only host/db), but your shell history will; prefer env
  vars or a scoped `.env` you delete after.
- Do region work **outside lesson hours** and treat it as a Tier-2 change
  (`CLAUDE.md`): stage on preview, keep the old region readable until the new one
  is verified.

## Which tier?

- **`db-clone-to-region.sh` (snapshot)** — needs a short **write-freeze** on the
  source (minutes at our scale). Simplest; correct for the first EU stand-up.
- **`db-logical-replication.sh` (streaming)** — **near-zero-downtime**: seed +
  stream the delta, so the freeze is just the final flip. Use when a freeze is
  unacceptable (must not drop an in-flight booking).

Both are backed by **`db-verify-clone.sh`** (per-table row count + order-
independent content checksum). A move you can't verify is a move you can't trust.

---

## Path A — snapshot clone (freeze window)

```sh
cd infra/database/scripts
export SRC='postgresql://…prod…'          # current region (read-only here)
export TGT='postgresql://…new-region…'    # provisioned by layer 1

# 1. Provision the target (layer 1): create a new Neon project in the target
#    region via console.neon.tech — see ../neon/README.md. (Not Tofu — the
#    original Supabase Tofu module's `tofu apply -var region=…` path was
#    retired along with Supabase itself, D-89.)
# 2. Freeze writes to SRC (maintenance mode / scale app to 0).
# 3. Clone schema+data into the EMPTY target. Auto-verifies; exits non-zero if parity fails.
./db-clone-to-region.sh "$SRC" "$TGT"
```

`--schema-and-data` (default) needs an **empty** target — `_prisma_migrations`
rides along, so a later `migrate deploy` on the new region is a clean no-op.
(`--data-only` is for a target you already ran layer-2 `migrate deploy` against,
e.g. a replication seed; it skips `_prisma_migrations` and uses
`--disable-triggers`, which needs the table-owner role.)

4. Repoint the app at the new region (`DATABASE_URL` / `DIRECT_URL`, or add it to
   `MIGRATE_REGIONS` — layer 2). Unfreeze. Keep the old region readable until
   you've smoke-tested the new one.

## Path B — logical replication (near-zero-downtime)

Prereq: **source `wal_level=logical`** (Supabase: enable in dashboard + restart;
self-hosted: `postgresql.conf`), and the **target already has the schema** —
logical replication carries no DDL, so run layer-2 `migrate deploy` against the
target first.

```sh
cd infra/database/scripts
R=./db-logical-replication.sh

# 1. Provision (layer 1) + migrate the target (layer 2) so its schema exists.
# 2. Start replication: publish on source, subscribe on target (copies then streams).
$R publish   "$SRC"
$R subscribe  "$TGT" "$SRC"          # add --no-copy if you pre-seeded with db-clone --data-only

# 3. Watch until caught up (caught_up = t, slot "behind" ~ 0 bytes).
$R status    "$TGT" "$SRC"

# 4. Cutover, briefly: freeze SRC writes → confirm 0 lag + parity → fix sequences → flip → teardown.
$R status    "$TGT" "$SRC"                       # confirm caught_up
./db-verify-clone.sh --exclude _prisma_migrations "$SRC" "$TGT"
$R sync-sequences "$SRC" "$TGT"                  # logical repl does NOT replicate sequences!
#   → flip the app region pointer (DATABASE_URL / MIGRATE_REGIONS) now ←
$R teardown  "$TGT" "$SRC"                       # drop subscription + publication
```

**Do not skip `sync-sequences`.** Sequences (serial ids) aren't replicated, so
the fresh target's counters sit at 1 and will hand out **colliding primary keys**
the moment the app writes to it. Run it after the freeze, before the flip.

## Rehearse first (D-49: "a reproducible deploy is only trustworthy if tested")

Before trusting any of the above, rehearse a clone against a **throwaway** target
— read-only w.r.t. prod, touches no real region:

```sh
cd infra/database/scripts
./db-rehearse-clone.sh "$SRC"                    # spins an ephemeral Docker postgres, clones, verifies, tears down
# …or against a Supabase/Neon branch instead of Docker:
REHEARSE_TARGET_URL='postgresql://…branch…' ./db-rehearse-clone.sh "$SRC"
```

## Rollback

- **Path A:** the source was frozen, not touched — un-freeze it and repoint the
  app back. The half-built target is disposable (drop it).
- **Path B:** before the flip, replication is additive and one-way — just
  `teardown` and keep serving from the source.
- After a flip, roll back the app pointer to the still-readable old region (why
  you keep it live until smoke-tested), then re-sync forward before retrying.

## Provider notes

- **Any target (Supabase, Neon, RDS, self-hosted), WITH real data to
  preserve:** run layer-2 `migrate deploy` on the target first (creates
  schema + extensions there — as of the 2026-07-13 portable-baseline squash,
  this is a single migration with zero Supabase-specific SQL, so this step
  needs no special handling on any provider), then `db-clone --data-only`.
  (If the target's data is disposable — e.g. SpiralClass's preview database,
  see `../neon/README.md` — skip the clone entirely: `migrate deploy` +
  reseed is simpler and needs no freeze window.)
