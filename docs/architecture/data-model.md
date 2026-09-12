# Data model

82 models, 2 migrations, 128 indexes and 23 unique constraints of PostgreSQL,
reached through Prisma, hosted on Neon. (Two migrations, not two hundred — the
history was squashed into a regenerable baseline plus a hand-authored invariants
file; see [Migrations](#migrations).) The schema
(`apps/web/prisma/schema.prisma`) is heavily commented and is the authority;
this document covers the decisions a reader cannot recover by reading columns.

For the components around it see the [architecture overview](overview.md); for
how the live diagram is generated see [ERD.md](ERD.md).

## Tenancy: application-level scoping, and nothing else

**Every tenant-owned row carries `teacherId`, and isolation is enforced by the
`where` clause on every query. There is no row-level security.**

This is the single largest security assumption in the system, and it is stated
plainly rather than buried: a missing `where teacherId = ?` on an admin,
webhook or service query is a **reportable vulnerability**, not a style nit.
[`SECURITY.md`](../../SECURITY.md) says so, so that it is treated as one in
review.

Why it is like that: the isolation boundary would have to be re-established in
Postgres roles and policies for a system that has exactly one application
process and one connection pool, and the failure mode of an incomplete policy
set is the same class of bug as a missing `where` — with the added property that
it is invisible from the application code. That trade is defensible at this size
and would not be at a larger one; it is written down so the reversal is a
decision rather than a discovery.

**What checks it.** [D-175](../decisions/D-175.md) moved that assumption off
the reviewer and onto the gate: `apps/web/scripts/tenancy-guard.mjs` parses
every Prisma call against a model carrying `teacherId` and reports the ones
that do not constrain themselves to a tenant, ratcheted against a baseline by
`apps/web/tests/authz/tenancy-guard.test.ts`. A query that genuinely reads
across tenants — the admin console does, by design — says so at the call site
with `// tenancy-exempt: <reason>`. Read the record before assuming the check
covers more than it does: a `where` built at runtime and raw SQL are both
outside what it can see, and it verifies that a query names a tenant, never
that it names the right one.

## Identity: a student belongs to several teachers

The most consequential modelling decision in the schema. **A `Student` is a
per-teacher row**: a human being who studies with two teachers is _two rows_,
joined at read time by an identity aggregation rather than being one global
record, and `students.email` is deliberately not globally unique.

That is why the student portal has no "current teacher" concept at all, why
class credits are fungible only within a `(teacher, identity set, class length)`
pool, and why duplicate detection and merging are first-class features. The
rules — including which two preferences are allowed to apply across the identity
set and why — are in
**[multi-teacher-students.md](multi-teacher-students.md)**, which is
authoritative for this model.

Do not unify to a global `Student` and do not add a global unique index on
email: consent scoping, archive semantics, per-teacher pricing and GDPR deletion
all depend on per-teacher rows.

## Money

**Every amount is an integer in minor units.** The columns say so
(`amount_minor_units`), and there is no floating-point money anywhere in the
schema or the code.

The major↔minor conversion is **currency-aware on both sides**, and must stay
that way. The platform prices in about 40 curated currencies and several of them
— CLP, JPY, KRW, VND, PYG, UGX, XAF, XOF — have **no minor unit at all**. A
conversion that assumes two decimals multiplies those prices by a hundred.
Adding a currency to the curated list means adding its exponent to
`MINOR_UNIT_EXPONENTS` in `packages/shared/src/money.ts` in the same change,
unless it is genuinely 2-decimal.

Two currency concepts are deliberately independent and must never be conflated:

| Concept                             | Column                      | Set by                  |
| ----------------------------------- | --------------------------- | ----------------------- |
| What a teacher charges her students | `teachers.pricing_currency` | Her, once at onboarding |
| What a teacher pays SpiralClass     | Platform billing, GBP       | The platform            |

They have separate configuration, separate Stripe accounts and separate
webhooks. A teacher pricing in MXN is billed in GBP, and a pre-2026 subscriber
keeps their real historical MXN price forever rather than having it
reinterpreted.

## Concurrency lives in the database

Booking is where correctness is bought with real constraints rather than
application-level checking.

A booking write is guarded by **three database objects**, all of which mean
"that slot is taken":

| Object                                | Kind                    | Surfaces as                           |
| ------------------------------------- | ----------------------- | ------------------------------------- |
| `bookings_teacher_slot_active_unique` | partial unique index    | Prisma `P2002`                        |
| `bookings_no_overlap_active`          | `EXCLUDE` on interval   | SQL state `23P01`, unmapped by Prisma |
| `bookings_no_overlap_buffered`        | `EXCLUDE`, buffer-aware | SQL state `23P01`, unmapped by Prisma |

The two `EXCLUDE` constraints raise `23P01`, which Prisma does not map to a
P-code and surfaces as an unknown-request error carrying the constraint name.
`lib/booking/slot-conflict.ts` recognises all three and maps them to one
friendly outcome instead of a 500.

**A pre-flight availability check is a courtesy; the constraint is the
guarantee.** The buffer-aware constraint indexes a denormalised column rather
than joining to `teachers.buffer_min`, because an `EXCLUDE` constraint cannot
join — the schema comment at that column explains the trade.

Package credit consumption takes the same posture. The claim is a field
comparison (`classes_used < classes_total`) under a row lock inside the
transaction. The ordering rule — always draw from the soonest-to-expire eligible
credit — decides only _preference_: if a concurrent booking drains the
front-runner, the loser advances to the next credit rather than failing. That
rule exists because the previous behaviour defaulted to the newest package,
which silently drained top-ups while older paid-for classes expired unused.

There is **deliberately no raw SQL in that path**, so the identical code runs
against the real database and against the in-memory test fakes.

## Closed unions over free-form JSON

Where a column could plausibly have been a JSON blob, it is a closed union with
typed columns, a `CHECK` constraint and application-level validation. Two places
where that is load-bearing:

- **Payout instruments.** `teacher_payout_instruments.kind` is an enum with one
  member today (`wise`). The union survives a single member because it is what a
  second kind would return through, and because dropping it would make the
  column say nothing. What must never come back is a free-form payee blob: every
  value a student pays against has to be machine-checkable, since an unvalidated
  one is the single place this rail loses real money with no way back. That rule
  outlived the 15-scheme registry it was written for
  ([D-124](../decisions/D-124.md), removed by
  [D-145](../decisions/D-145.md)).
- **Testimonials.** `testimonials.source` is `teacher_curated` or
  `student_submitted`, and a `CHECK` constraint ties `source`, `student_id` and
  `verified_at` together so `verified_at` cannot be written without the student
  row the claim is about. Every teacher-side write filters
  `source: "teacher_curated"`, so a teacher can hide or delete a verified
  testimonial but never create or edit one. The class count on the badge is
  **derived at render time**, never stored — a copied number drifts the next
  lesson.

By contrast, scheme and currency identifiers are validated in the application
layer rather than enumerated as Postgres types
([D-64](../decisions/D-64.md)), deliberately: adding a currency should be a
constant, not a migration.

## Migrations

**There are two, and the split between them is the point.**

| Migration               | Written by | Contains                                                                     |
| ----------------------- | ---------- | ---------------------------------------------------------------------------- |
| `…_schema_baseline`     | Prisma     | Everything `schema.prisma` expresses — tables, enums, indexes, FKs, defaults |
| `…_database_invariants` | A person   | The half Prisma's schema language cannot say                                 |

Neither is the schema on its own; `migrate deploy` applies both, in order, and
a database is correct only once it has run both.

The baseline is **regenerated, never edited** — `prisma migrate diff
--from-empty --to-schema-datamodel` reproduces it byte for byte. That is the
property worth protecting, and it is exactly the property a single combined file
destroys: the hand-written SQL mixed into it would be silently dropped the first
time anyone regenerated. So the partial indexes, the CHECK constraints, the two
GiST exclusion constraints and the two triggers live in their own file, and
"regenerate the first, hand-review the second" is a procedure rather than a
thing to remember.

⚠️ **The drift check compares MODELS**, so it cannot see a missing constraint.
Read [`apps/web/prisma/migrations/README.md`](../../apps/web/prisma/migrations/README.md)
before touching either file.

**An applied migration is never edited, not even a comment.** Prisma checksums
each file and any drift breaks `migrate deploy` on the next environment.
Correcting a mistake means a new migration.

Production migrations run behind a **Neon checkpoint branch**
([D-95](../decisions/D-95.md)), created by `scripts/fly-deploy.sh` before
anything is applied, because a code rollback never undoes a schema change. The
restore path is a script — `infra/database/scripts/neon-rollback.sh` — not a
plan. See [`DB_BACKUP_RESTORE.md`](../deployment/DB_BACKUP_RESTORE.md).

The **expand/contract discipline** (add a column, backfill, switch reads, drop
in a later release) no longer has a client that can lag a deploy — the mobile
app it protected is gone. Keep it anyway for anything a **third party** calls:
today that is the Stripe and LiveKit webhooks, where the caller is not ours to
update.

Only one migration-bearing branch should be in flight at a time. Two branches
each adding a migration collide on ordering and checksums.

## The live ERD

`/admin/database` generates an entity-relationship diagram **from the running
schema**, not from a checked-in picture that would rot. A drift guard fails the
build if the generated DBML is out of step with `schema.prisma`, so the diagram
cannot silently describe an older database. See [ERD.md](ERD.md).

## Related

- [Architecture overview](overview.md) — the components around the database
- [Payments](../features/payments.md) — how a payment row reaches `paid`
- [Packages](../features/packages.md) — credit balance, expiry and headroom
- [`SECURITY.md`](../../SECURITY.md) — the tenancy assumption, stated as policy
