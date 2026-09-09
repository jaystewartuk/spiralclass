# Roster reset (delete student packages & classes)

The inverse of `scripts/import/`. Deletes a single teacher's student
**packages** and **bookings** (classes) — plus the rows that hang off them
(payments, class materials, and the notifications that referenced them) — so
the teacher can re-enter that activity cleanly. It writes directly to the
database with the service role and **sends nothing**: no confirmations, no
reminders, no push/email.

> Use case: a teacher imported (or hand-entered) a first pass of packages and
> classes and now wants to wipe just that and re-create it from her notebook —
> without deleting students or redoing onboarding.

## What it deletes vs. keeps

**Deletes (scoped to the teacher):**

- `packages` — the student packages (their class balances)
- `bookings` — the scheduled/completed classes
- `payments` — removed by cascade when their package is deleted
- `class_materials` — removed by cascade when their booking is deleted
- `notifications` that referenced any of those bookings/payments

**Keeps (untouched):**

- `package_templates` — the reusable package definitions
- `students` + `teacher_students` — the roster, including each student's
  notification preferences and any silent-onboarding hold. Re-created packages
  and classes attach to the same already-silenced student rows.
- levels, materials library, availability, Stripe/Wise/subscription state

## Usage

```bash
# Dry run — prints exactly what would be deleted, writes nothing.
pnpm cleanup:roster --teacher <slug-or-id>

# Delete (irreversible — take a DB snapshot first).
pnpm cleanup:roster --teacher <slug-or-id> --commit

# No direct DB connection? Emit the DELETE SQL to a file and run it in a
# SQL console / via MCP. --teacher must be the teacher UUID here.
pnpm cleanup:roster --teacher <uuid> --emit-sql --out cleanup.sql
```

Always dry-runs by default. `--commit` is the only thing that writes, and it
runs every delete inside a single transaction.

## Notifications stay silent afterwards

Deleting and re-creating packages/classes never messages the imported
students: their `students.notification_prefs` were backfilled all-off at
import, and the dispatcher gates every student lifecycle send on those prefs.
This script leaves those prefs in place. The teacher still gets her own
teacher-facing confirmations, exactly as before.
