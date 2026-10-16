# Data model

82 models, 7 migrations, 128 indexes and 23 unique constraints of PostgreSQL,
reached through Prisma, hosted on Neon. The schema
(`apps/web/prisma/schema.prisma`) is heavily commented and is the authority;
this document covers the decisions a reader cannot recover by reading columns.

For the components around it see the [architecture overview](overview.md); for
the generated diagram at `/admin/database` see [ERD.md](ERD.md).

## Tenancy: application-level scoping, and nothing else

**Tenant-owned rows carry `teacherId`, and isolation is enforced by the `where`
clause on every query. There is no row-level security.**

A missing `where teacherId = ?` on an admin, webhook or service query is a
**reportable vulnerability**, not a style nit — [`SECURITY.md`](../../SECURITY.md)
says so. The trade (one application process, one connection pool, no Postgres
policies to keep complete) is written down in [D-175](../decisions/D-175.md) so
that reversing it is a decision rather than a discovery.

Two checks enforce it, and neither subsumes the other (D-175):

| Check                                       | Reads                     | Asks                                                    |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `apps/web/scripts/tenancy-guard.mjs` (gate) | Source, every Prisma call | Does this query name a tenant at all?                   |
| `lib/tenancy/guard.ts` (Prisma extension)   | Arguments, at runtime     | Is the tenant it names the one this request is serving? |

The scanner ratchets against a baseline in
`apps/web/tests/authz/tenancy-guard.test.ts`; a `where` built at runtime and raw
SQL are outside what it can see. A query that reads across tenants on purpose —
the admin console does — says so at the call site with
`// tenancy-exempt: <reason>`, and at runtime with `runCrossTenant()`. The
runtime guard **reports** in production and **throws** in development and test,
unless `TENANCY_GUARD` says otherwise (`guardMode()` in `lib/tenancy/guard.ts`).

Both treat a model as tenant-owned when it has a `teacherId` column. `students`
has none — see the next section.

## Identity: a student belongs to several teachers

The most consequential modelling decision in the schema. A human being who
studies with two teachers is **two `students` rows**, each bound to its teacher
through a `teacher_students` pairing (keyed on `(teacher_id, student_id)`),
joined at read time by an identity aggregation rather than being one global
record. `students.email` is deliberately not globally unique, and `students`
carries no `teacher_id` of its own — a query reaches a teacher's students
through `teacherStudents`.

Do not unify to a global `Student` and do not add a global unique index on
email: consent scoping, archive semantics, per-teacher pricing and GDPR deletion
all depend on per-teacher rows. The rules — the identity set, the two
preferences allowed to cross it, and what reads across it — are in
**[multi-teacher-students.md](multi-teacher-students.md)**.

## Money

**Every amount is an integer in minor units.** The columns say so
(`amount_minor_units`, `price_minor_units`, …), and CHECK constraints in the
invariants migration keep them non-negative.

The major↔minor conversion is **currency-aware on both sides**: several curated
currencies — CLP, JPY, KRW, VND, PYG, UGX, XAF, XOF among them — have no minor
unit, and a conversion that assumes two decimals multiplies their prices by a
hundred. A new curated currency needs its exponent added to
`MINOR_UNIT_EXPONENTS` in `packages/shared/src/money.ts` in the same change,
unless it is genuinely 2-decimal.

What a teacher charges her students (`teachers.pricing_currency`) and what she
pays SpiralClass (platform billing, recorded per subscription row) are separate
concepts with separate configuration and webhooks — see
[payments.md](../features/payments.md) and
[subscriptions.md](../features/subscriptions.md).

Currency and country codes are validated in the application layer, with only a
format CHECK in Postgres, so adding a currency is a constant rather than a
migration ([D-153](../decisions/D-153.md)).

## Concurrency lives in the database

Booking is where correctness is bought with real constraints rather than
application-level checking. A booking write is guarded by **three database
objects**, all of which mean "that slot is taken":

| Object                                | Kind                    | Surfaces as                           |
| ------------------------------------- | ----------------------- | ------------------------------------- |
| `bookings_teacher_slot_active_unique` | partial unique index    | Prisma `P2002`                        |
| `bookings_no_overlap_active`          | `EXCLUDE` on interval   | SQL state `23P01`, unmapped by Prisma |
| `bookings_no_overlap_buffered`        | `EXCLUDE`, buffer-aware | SQL state `23P01`, unmapped by Prisma |

Prisma does not map `23P01` to a P-code; it surfaces as an unknown-request
error carrying the constraint name. `lib/booking/slot-conflict.ts` recognises
all three and maps them to one friendly outcome instead of a 500.

**A pre-flight availability check is a courtesy; the constraint is the
guarantee.** An `EXCLUDE` constraint cannot join, so the buffer-aware one
indexes `bookings.buffered_end`, which a `BEFORE INSERT` trigger derives from
the row's `buffer_min_snapshot` — snapshotted so that changing a teacher's
buffer never invalidates bookings already sold.

Package credit consumption takes the same posture (`lib/booking/credit-ledger.ts`).
The claim is a conditional update (`classes_used < classes_total`) inside the
booking transaction. Credits are drawn soonest-to-expire first within one
`(teacher, identity set, class length, seats)` pool; the ordering decides only
_preference_ — if a concurrent booking drains the front-runner, the loser
advances to the next credit rather than failing. There is **no raw SQL in that
path**, so the identical code runs against the real database and the in-memory
test fakes. Balance and expiry rules: [packages.md](../features/packages.md).

## Closed unions over free-form JSON

Where a column could plausibly have been a JSON blob, it is a closed union with
typed columns, a `CHECK` constraint and application-level validation:

- **Payout instruments.** `teacher_payout_instruments.kind` is an enum with one
  member (`wise`), kept because it is what a second kind would return through.
  CHECKs require a well-formed `wise_handle` on an enabled instrument. Never add
  a free-form payee field: every value a student pays against must be
  machine-checkable ([D-145](../decisions/D-145.md)).
- **Testimonials.** `testimonials_verified_shape` ties `source`, `student_id`
  and `verified_at` together, so a `student_submitted` row cannot exist without
  the student and a `teacher_curated` row cannot carry either
  ([D-151](../decisions/D-151.md)). Behaviour:
  [student-acquisition.md](../features/student-acquisition.md).
- **Payments.** A `manual_transfer` payment must carry a `payment_reference`
  and an `instrument_id`; any other provider must not carry an instrument.

## Migrations

**The squashed history is two migrations, and the split between them is the
point.** Every change since is an ordinary incremental migration on top.

| Migration               | Written by | Contains                                                                                       |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `…_schema_baseline`     | Prisma     | Everything `schema.prisma` expresses — tables, enums, indexes, FKs, defaults                   |
| `…_database_invariants` | A person   | `btree_gist`, partial indexes, CHECK constraints, the two GiST exclusion constraints, triggers |

The baseline is regenerated, never edited; the hand-written half lives in its
own file so regenerating cannot silently drop it.
⚠️ **The drift check compares models**, so it cannot see a missing constraint —
`apps/web/tests/migrations/invariants.integration.test.ts` inventories a
really-migrated database for that. Read
[`apps/web/prisma/migrations/README.md`](../../apps/web/prisma/migrations/README.md)
before adding a migration or touching either file.

- **An applied migration is never edited, not even a comment.** Prisma
  checksums each file and any drift breaks `migrate deploy` on the next
  environment. Correct a mistake with a new migration.
- **Every migration expands.** A production deploy migrates before its new code
  serves, so old code always meets the new schema. A drop, rename or narrowing
  ships a release _after_ the code that stopped using it, marked `CONTRACT`
  ([D-178](../decisions/D-178.md),
  `apps/web/tests/migrations/contract-migrations.test.ts`).
- **Production migrations run behind a Neon checkpoint branch**, created by
  `scripts/database-deploy.sh` before anything is applied, because a code
  rollback never undoes a schema change. The restore path is
  `infra/database/scripts/neon-rollback.sh` — see
  [`DB_BACKUP_RESTORE.md`](../deployment/DB_BACKUP_RESTORE.md).
- **Only one migration-bearing branch in flight at a time.** Two collide on
  ordering and checksums.

## Related

- [Architecture overview](overview.md) — the components around the database
- [ERD.md](ERD.md) — the generated schema diagram and its drift guard
- [Payments](../features/payments.md) — how a payment row reaches `paid`
- [Packages](../features/packages.md) — credit balance, expiry and headroom
- [`SECURITY.md`](../../SECURITY.md) — the tenancy assumption, stated as policy
