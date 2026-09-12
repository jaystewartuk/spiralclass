# Migrations

The squashed history is two files, and the split between them is the point.
Every change since is an ordinary migration on top of them — see
[Adding a schema change](#adding-a-schema-change).

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
  --from-empty --to-schema prisma/schema.prisma --script
```

reproduces it byte for byte, below its comment header. That is the property
worth protecting — and it is exactly the property a single combined file
destroys, because the raw SQL mixed into it would be silently dropped the first
time anyone regenerated.
Keeping the hand-authored half in its own file makes "regenerate the first,
hand-review the second" a procedure rather than a thing to remember.

Prisma 7 renamed `--to-schema-datamodel` to `--to-schema` and removed
`--from-url`. The baseline's own header still spells the old flag, and stays
that way because the file is checksummed. Nothing else here may:
`tests/migrations/readme-commands.test.ts` runs the command above, and checks
every flag in this file's shell blocks against the installed CLI.

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
Adopt it instead, once, before the next `migrate deploy` ever runs there.

**Verify first.** From `apps/web`, with `DIRECT_URL` naming that database —
since Prisma 7, `prisma.config.ts` is the only way a URL reaches the CLI:

```bash
prisma migrate diff --from-config-datasource \
  --to-schema prisma/schema.prisma --script
```

A database the old history migrated prints exactly the objects a retired
feature left behind — the baseline never creates them, and
`20260912120000_drop_retired_intro_calls` removes them. ⚠️ **Anything else in
the output means stop:**

```sql
-- DropForeignKey
ALTER TABLE "intro_calls" DROP CONSTRAINT "intro_calls_student_id_fkey";
-- DropForeignKey
ALTER TABLE "intro_calls" DROP CONSTRAINT "intro_calls_teacher_id_fkey";
-- AlterTable
ALTER TABLE "teachers" DROP COLUMN "intro_calls_available";
-- DropTable
DROP TABLE "intro_calls";
-- DropEnum
DROP TYPE "IntroCallStatus";
```

Then adopt:

```bash
prisma migrate resolve --applied 20260906120000_schema_baseline
prisma migrate resolve --applied 20260906120100_database_invariants
```

`migrate resolve` only writes rows to `_prisma_migrations`; it runs none of
the SQL. ⚠️ **`prisma migrate status` now exits 1, and that is correct:** it
names the drop migration as not yet applied and the old history's rows as
missing locally. The next `migrate deploy` — the deploy's own, after its Neon
checkpoint — applies the drop. From then on `status` prints
`Database schema is up to date!` and the diff above prints
`-- This is an empty migration.` The old history's rows stay, and nothing
reads them.

⚠️ **If a `migrate deploy` reaches the database before the adoption**, it stops
at the baseline's first `CREATE TYPE` (P3018), applies nothing, and records
the baseline as failed, which blocks every later deploy. The two `resolve`
commands above still work unchanged and clear it.

The diff covers the models only. The invariants are invisible to it, so
verify them directly — this lists every object the second migration creates,
and is the same query used to prove the two files reproduce the schema an
older history produced. Run it on the adopted database and on a fresh one
(`pnpm db:dev:up`), and diff the two:

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
behind `pnpm db:dev:up`, CI — needs none of this. It just runs every
migration like any other, and the drop finds nothing to drop.
