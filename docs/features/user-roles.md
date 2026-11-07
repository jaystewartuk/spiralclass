# User roles

Three kinds of people use SpiralClass: **teachers**, **students**, and
**staff** (SpiralClass's own operators). A role is never picked by the user; it
follows from which record the system finds or creates for her sign-in
identity.

This document is the role model. The details live elsewhere:

- how sign-in resolves and links a role: [authentication.md](authentication.md);
- the operator console and its tools: [admin-portal.md](admin-portal.md);
- one person studying with several teachers:
  [docs/architecture/multi-teacher-students.md](../architecture/multi-teacher-students.md).

## The roles

- **Teacher** — owns a booking page, a roster, packages, payment setup and a
  dashboard. One `Teacher` row per sign-in identity.
- **Student** — on one or more teachers' rosters. A person studying with two
  teachers has **two `Student` rows**, one per teacher, each carrying that
  teacher's private notes and prices; once she signs in, both are linked to
  her one identity.
- **Staff** — not a tenant. An `AdminUser` row with a role; a separate kind of
  record from teachers and students.

## Teacher and student are mutually exclusive

One sign-in identity is a teacher or a student, never both. A flow that would
create or link the other role for an identity that already has one is refused
with a conflict instead of mixing them. `requireTeacher` (`lib/auth.ts`)
refuses to create a Teacher row for an identity that has a claimable Student
row, and sends it to the student portal.

## How each role comes to exist

- **Teacher**: only the sign-up flow creates one, from the explicit `intent`
  the sign-up form sends ([D-40](../decisions/D-40.md)); signing in never
  creates a teacher.
- **Student**: a `Student` row can exist before anyone signs in — added by a
  teacher, invited, or created by a purchase on the public booking page. The
  first sign-in with a matching, unlinked email links it.
- **Staff**: created by another admin at `/admin/staff`. While no `AdminUser`
  row exists at all, an email on the `SUPERUSER_EMAILS` allowlist acts as a
  temporary superadmin, so a fresh database can be bootstrapped
  ([D-25](../decisions/D-25.md)); once one real row exists the allowlist no
  longer applies.

## Staff roles

`AdminRole` ranks, named capabilities, two-factor step-up and the page each
role reaches are owned by
[admin-portal.md](admin-portal.md#identity-roles-and-capabilities).

## Routing

`src/middleware.ts` (via `lib/auth/middleware.ts`) bounces a visitor with no
session away from protected paths:

| Paths                                                                   | Role    | Without a session      |
| ----------------------------------------------------------------------- | ------- | ---------------------- |
| `/dashboard`, `/onboarding`, `/settings`, `/payments`, `/notifications` | Teacher | `/sign-in?next=<path>` |
| `/my-classes`                                                           | Student | `/`                    |
| `/admin`                                                                | Staff   | `/sign-in?next=<path>` |

The middleware checks only that a session exists. The authoritative check is
the page or handler's own guard: `requireOnboardedTeacher` / `requireTeacher`,
`requireStudent`, `requireAdmin`. A signed-in identity with no Student row on
a student page is sent to `/?error=no-student-record`.

## Boundaries

- A teacher sees and changes only her own students, packages, bookings and
  settings. Every query is scoped by `teacherId`; there is no database-side
  row-level security.
- A student sees only her own bookings, packages and settings with the
  teachers she is linked to.
- Staff act across tenants only through the admin console, gated by role.
