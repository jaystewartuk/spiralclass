# Teacher roster import

One-time importer for onboarding a teacher's **existing** students, class
balances, and committed agenda — the stuff they tracked by hand before
SpiralClass (a notebook, a spreadsheet, WhatsApp). It writes directly to the
database with the service role and **sends nothing**: no confirmations, no
reminders, no push/email. Students hear from us only when you invite them,
on your timing.

> This is for the **initial migration** of a book of business. Day-to-day,
> students self-serve through the public booking + payment funnel — you do
> **not** re-run this for normal activity.

## The three files

You fill three CSVs. The headers must stay **exactly** as shipped — the
importer matches on them. Keep the example rows while you learn the format,
then delete them before the real run.

Copy `templates/` to a working folder and edit there:

```
scripts/import/data/<teacher-slug>/students.csv
scripts/import/data/<teacher-slug>/packages.csv
scripts/import/data/<teacher-slug>/bookings.csv
```

The files are linked by **`*_ref` columns** — short labels _you_ invent to
join rows across files. They never appear in the app; they only wire the three
CSVs together and make re-runs idempotent. Use anything stable and unique
(e.g. `maria-h`, `carlos-r`). Once chosen, don't change a ref between runs.

---

### 1. `students.csv` — who they are

| Column        | Required | Format / example      | Notes                                                |
| ------------- | -------- | --------------------- | ---------------------------------------------------- |
| `student_ref` | **yes**  | `maria-h`             | Unique per student. The join key.                    |
| `name`        | **yes**  | `María Hernández`     | Accents fine.                                        |
| `email`       | no       | `maria@example.com`   | See "About email" below. Leave blank if unknown.     |
| `phone`       | no       | `+5215555000001`      | E.164 only: `+` then country code, no spaces/dashes. |
| `timezone`    | no       | `America/Mexico_City` | IANA name. Blank → `America/Mexico_City`.            |
| `locale`      | no       | `es-MX`               | Blank → `es-MX`.                                     |

**About email.** A student can only sign in and see their own classes once
their email is on file (first magic-link sign-in matches by email). You can
import with email blank and add it later, but the student stays
teacher-managed until then. Collect emails now if you can — it unblocks
self-service on day one.

---

### 2. `packages.csv` — what they've paid for

One row per package a student bought. Remaining classes are computed as
`classes_total − classes_used`, so these two numbers must match the notebook
exactly — this is the most important reconciliation in the whole import.

| Column           | Required | Format / example | Notes                                                                               |
| ---------------- | -------- | ---------------- | ----------------------------------------------------------------------------------- |
| `package_ref`    | **yes**  | `maria-h-p1`     | Unique per package. Join key for bookings.                                          |
| `student_ref`    | **yes**  | `maria-h`        | Must exist in `students.csv`.                                                       |
| `classes_total`  | **yes**  | `20`             | Classes the package includes.                                                       |
| `classes_used`   | **yes**  | `3`              | Classes **already consumed** (completed historically). `0` for a brand-new package. |
| `price_paid_mxn` | **yes**  | `5500`           | Pesos. `5500` = $5,500.00 MXN. Decimals ok (`5500.50`).                             |
| `purchased_date` | **yes**  | `2026-05-01`     | `YYYY-MM-DD`.                                                                       |
| `expires_date`   | no       | `2026-09-01`     | `YYYY-MM-DD`. Blank = never expires.                                                |
| `status`         | no       | `active`         | `active` (default), `paused`, or `expired`. Only `active` packages are bookable.    |

**`paused` packages.** Use `paused` for a package the student has paid for
but isn't drawing against right now (a break, a hold). The balance is kept
exactly as imported, but it's **not bookable** until you resume it (flip to
`active`) from the teacher dashboard. Don't put `scheduled` bookings against a
paused package — the slot would block the calendar even though the package
can't be used. `expired` is for packages that are done; `paused` is a
reversible hold.

**`classes_used` vs. future bookings.** `classes_used` counts only classes
**already taken**. Classes that are scheduled but not yet taught go in
`bookings.csv` as `scheduled` rows — do **not** pre-count them in
`classes_used`, or the student's balance will read low and they'll get
double-counted when the class is later marked complete.

---

### 3. `bookings.csv` — the committed agenda

One row per class that's on the books. Two reasons to include a row:

- **Future, agreed classes** (`scheduled`) — these **block that time on the
  calendar** so no one else can book it, and they show up in the student's and
  teacher's agenda. If you skip these, those committed times will appear free
  to new students.
- **Past classes** (`completed`) — optional, only if you want the history on
  record. They do **not** block anything and don't affect balances (already
  reflected in `classes_used`).

| Column           | Required | Format / example   | Notes                                                                                    |
| ---------------- | -------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `student_ref`    | **yes**  | `maria-h`          | Must exist in `students.csv`.                                                            |
| `package_ref`    | **yes**  | `maria-h-p1`       | Which package this class draws from. Must exist in `packages.csv`.                       |
| `start_datetime` | **yes**  | `2026-06-04 10:00` | `YYYY-MM-DD HH:MM`, 24-hour, in the **student/teacher local time** (the row's timezone). |
| `duration_min`   | no       | `50`               | Blank → `50`.                                                                            |
| `status`         | **yes**  | `scheduled`        | `scheduled` (future, blocks the slot) or `completed` (past history).                     |

**No two `scheduled` rows may share the same teacher start time** — the
database allows only one active class per slot. The importer flags collisions.

---

## How dates & money are interpreted

- **Datetimes are local**, converted to UTC on import using the student's
  `timezone` (default `America/Mexico_City`). Write `10:00` and the student
  sees 10:00 their time.
- **Money is pesos** in the sheet; stored as minor units internally. `5500` →
  `$5,500.00`.

## Running it (you, the operator — not the teacher)

Note the `--` before the flags (it tells pnpm to forward them to the script):

```
# Dry run — validates and prints a reconciliation report, writes NOTHING.
# CSV validation runs fully offline; the DB is only touched to resolve the
# teacher and to commit:
pnpm import:roster -- --teacher <booking-slug> --dir scripts/import/data/<teacher-slug>

# Commit — same, but actually writes:
pnpm import:roster -- --teacher <booking-slug> --dir scripts/import/data/<teacher-slug> --commit
```

Workflow: dry-run → read the report → fix the CSVs → dry-run again → repeat
until clean → `--commit`. The import is **idempotent**: re-running with the
same refs updates the same rows instead of duplicating, so fixing a typo and
re-committing is safe.

After committing, verify in the teacher's dashboard / Prisma Studio that every
balance matches the notebook and that committed times show as blocked on the
public booking page — **before** inviting anyone.
