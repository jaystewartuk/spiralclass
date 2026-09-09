# Migrations

Two files, and the split between them is the point.

| Migration                            | Written by | Contains                                                                                                      |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `20260906120000_schema_baseline`     | Prisma     | Tables, enums, indexes, foreign keys, defaults — everything `schema.prisma` expresses                         |
| `20260906120100_database_invariants` | A person   | `btree_gist`, partial indexes, CHECK constraints, GiST exclusion constraints, NOT NULL on lists, two triggers |

Neither is the schema on its own. `prisma migrate deploy` applies both, in
order, and a database is only correct once it has run both.

## Why two, and not one or forty-six

The baseline is **regenerated, never edited**:

```bash
pnpm --filter spiralclass-web exec prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

reproduces it byte for byte. That is the property worth protecting — and it
is exactly the property a single combined file destroys, because the raw SQL
mixed into it would be silently dropped the first time anyone regenerated.
Keeping the hand-authored half in its own file makes "regenerate the first,
hand-review the second" a procedure rather than a thing to remember.

The second file is the half Prisma cannot help with. `prisma migrate dev` will
never write a partial index or an exclusion constraint for you, and the
migration-drift check in `scripts/ci/integration.sh` compares **models** — so
it cannot see a CHECK constraint you dropped. `tests/migrations/invariants.integration.test.ts`
is what does: it inventories the catalog of a really-migrated database and
fails on anything missing from that file.

## Adding a schema change

1. Edit `prisma/schema.prisma`.
2. `pnpm --filter spiralclass-web prisma:migrate` — Prisma writes a normal
   incremental migration on top of these two. Do **not** regenerate the
   baseline for a routine change; that is what migrations are for.
3. If the change needs a partial index, a CHECK, an exclusion constraint or a
   trigger, hand-write it in that same new migration, add it to the list in
   `tests/migrations/invariants.integration.test.ts`, and note it on the model
   in `schema.prisma` so the next person reading the model knows a rule exists
   that the model cannot show them.

Applied migrations are never edited afterwards, not even a comment: Prisma
checksums each file and `migrate deploy` fails on a mismatch.

## Applying to a database that already has tables

An environment that was migrated by an earlier, different history will not
accept the baseline — it would try to `CREATE TABLE` things that exist.
Adopt it instead, once, before the next `migrate deploy` ever runs there:

```bash
prisma migrate resolve --applied 20260906120000_schema_baseline
prisma migrate resolve --applied 20260906120100_database_invariants
prisma migrate status   # expect: up to date
```

`migrate resolve` only writes rows to `_prisma_migrations`; it runs none of
the SQL. Verify first that the database really does match — from a checkout
of this repo:

```bash
prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script
```

must print `-- This is an empty migration.`

That check covers the models only. The invariants are invisible to it, so
verify them directly — this lists every object the second migration creates,
and is the same query used to prove the two files reproduce the schema an
older history produced:

```sql
SELECT 'ext  ' || extname FROM pg_extension WHERE extname <> 'plpgsql'
UNION ALL
SELECT 'index ' || indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
UNION ALL
SELECT 'check ' || rel.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE con.contype IN ('c', 'x')
UNION ALL
SELECT 'trigger ' || tgrelid::regclass::text || '.' || tgname
  FROM pg_trigger WHERE NOT tgisinternal
ORDER BY 1;
```

A brand-new database — a fresh Neon branch, the `postgres:16` container
behind `pnpm db:dev:up`, CI — needs none of this. It just runs both
migrations like any other.
