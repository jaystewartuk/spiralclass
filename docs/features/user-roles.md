# User Roles

## Overview

SpiralClass has three kinds of people using the product: **Teachers** (who
manage their own classes, students, and payments), **Students** (who book and
pay for classes with one or more teachers), and **platform Staff/Admins**
(SpiralClass's own operators, not tenants of the product). A single sign-in
identity (one email/Google account) can be exactly one of Teacher or Student
— never both — while a Staff/Admin identity is a separate, non-tenant kind of
account layered on top with its own panel and its own tiers of seniority.
Role is never chosen by the user directly; it is always a consequence of
which record the system links or creates for their sign-in identity.

## User Stories

- As a teacher, I want a dashboard, settings, and booking tools scoped only
  to my own students and classes, with no visibility into other teachers'
  businesses.
- As a student, I want a simple portal to see and book my classes with the
  teacher(s) I study with, without seeing anything about other students or
  teacher-only tools.
- As a platform staff member, I want an admin panel completely separate from
  the teacher/student experience, with my own permissions based on my role
  (e.g., support vs. finance vs. superadmin).
- As a teacher, I want it to be impossible for my own account to
  accidentally also become a student account (or vice versa), since I might
  reasonably use the same email in both contexts.
- As any signed-in user, I want the app to route me to the right home screen
  automatically based on who I am, without me having to pick "I'm a teacher"
  or "I'm a student" myself.

## Business Rules

**The three roles**

- **Teacher** — owns a booking page, a roster of students, packages/pricing,
  payment-rail configuration, and a dashboard. One teacher record per
  sign-in identity (shared 1:1 with the underlying account).
- **Student** — belongs to one or more teachers' rosters. A single person
  studying with two different teachers on this platform has **two separate
  student records** (one per teacher relationship), not one shared record —
  each carries that teacher's own private notes/pricing about the student.
  All of those separate records are, however, linked to the same one
  sign-in identity once that identity has signed in.
- **Staff / Admin** — not a tenant at all. Platform employees/operators who
  manage the business itself (payments oversight, disputes, support,
  teacher/student administration, subscriptions, integrations, audit, cost
  monitoring). Fully separate record type from Teacher/Student.

**Teacher and Student are mutually exclusive per sign-in identity**

- A given sign-in identity (email or linked Google account) can be a Teacher
  or a Student, never both. Any flow that would otherwise create/link the
  "other" role for an identity that already has one is blocked with a
  conflict error instead of silently mixing the two.

**Staff seniority tiers**

- Staff accounts carry a role/tier that determines which admin capabilities
  they can use. From highest to lowest general authority: **Superadmin >
  Finance > Support**. Two additional roles, **Tester** and **Engineer**,
  sit outside that ranking entirely — they don't inherit access by seniority
  at all; they only get access to specific capabilities explicitly granted
  to them one at a time. This is a deliberate design: narrow, named grants
  for those two roles rather than "give them some general rank."
- A staff account can be disabled, which removes their admin access without
  deleting their record.
- A very small, environment-configured allowlist of emails can act as a
  temporary "bootstrap superadmin" if no real staff records exist yet in the
  database — intended as a transient state before real staff accounts are
  seeded, not a standing access path.

**How a sign-in identity becomes a Teacher**

- Only the sign-up flow (name + email, explicit "I'm creating an account"
  intent) can create a brand-new Teacher record for an identity that has
  none. This is deliberate: it stops someone mistyping an email address (or
  a student typing their own email somewhere unexpected) from accidentally
  becoming a teacher.

**How a sign-in identity becomes a linked Student**

- A Student record can exist before anyone ever signs in — created by a
  teacher manually, by CSV import, or automatically the first time someone
  buys a class through that teacher's public booking page.
- The first time a matching, not-yet-linked email signs in (by any method —
  email code, Google, or accepting a roster invitation), it is permanently
  linked to that pre-existing Student record (the oldest matching one, if
  more than one exists) — see `authentication.md` for the exact linking
  rules.
- A Student record that isn't on any teacher's roster is never auto-linked.

**How a Staff/Admin record is created**

- Not self-service. Admin/staff accounts are created by another admin (each
  staff record can reference who invited/created it), or bootstrapped via
  the environment allowlist described above when no staff records exist
  yet.

**Role-based routing**

- Web middleware protects broad route groups by role: teacher-only paths
  (dashboard, onboarding, settings, payments, notifications), student-only
  paths (the student portal), and admin-only paths — each redirects a
  signed-out visitor to sign in (teacher/admin paths preserve the original
  destination to return to after sign-in; student paths do not). This
  middleware check is a first line of defense only — the authoritative
  permission check happens in each page/route itself.
- A signed-in person hitting the sign-in or sign-up page is redirected away
  to their own home (admin panel, or dashboard) rather than shown the form
  again.
- The same three-way split existed as distinct navigation route
  groups: a teacher app section, a student app section, and (confirmed in
  code) a **full separate admin section** with its own drawer-style
  navigation, gated so that only a signed-in "superuser" can reach it —
  anyone else lands back at the ordinary app home.

**Cross-role permission boundaries**

- A teacher can only see/manage their own students, packages, bookings, and
  settings — never another teacher's.
- A student can only see/manage their own bookings/packages/settings with
  the teacher(s) they're linked to — never another student's data, and
  never a teacher's own settings/dashboard.
- Staff/admin emails are deliberately excluded from ordinary
  teacher/student-facing admin lists, because any signed-in email hitting a
  teacher-facing page would otherwise auto-provision a Teacher record for
  it.
- Admin access additionally requires two-factor enrollment and a recent
  "step-up" re-verification, on top of just being a staff account — see
  `authentication.md` for the exact mechanics.

## User Flow

**Determining role at sign-in** (see `authentication.md` for full detail):

1. Person signs in (code or Google).
2. System checks, in order: is this a staff/admin identity? A teacher? A
   linked student? An unclaimed-but-linkable roster student? None of the
   above?
3. Routes to the matching home screen — admin panel, teacher dashboard/
   onboarding, or student portal — or shows "no account found" if none
   match and the person wasn't in the sign-up flow.

**Teacher day-to-day navigation** (web: `/dashboard`, `/onboarding`,
`/settings`, `/payments`, `/notifications`):
scoped entirely to that teacher's own students, classes, packages, and
payment configuration.

**Student day-to-day navigation** (`/my-classes`; formerly also the
`(student)` route group): scoped to that student's own bookings/packages
with the teacher(s) they study with.

**Staff/admin navigation** (`/admin`):
a separate panel entirely — student/teacher administration, payments
oversight, disputes, subscriptions, integrations, cost monitoring, audit
logs — gated by role tier and by the 2FA step-up requirement.

## Data Used

- **Sign-in identity**: the single underlying account record (email, name,
  verification status, 2FA enrollment) shared by whichever role(s) reference
  it.
- **Teacher record**: one per teacher identity — onboarding status, booking
  configuration, pricing/payment-rail setup, dashboard layout preferences,
  notification preferences.
- **Student record**: one per (teacher, student) relationship — whether
  linked to a sign-in identity yet, the teacher's own private notes about
  that student, that student's own notification preferences and booking
  history with that specific teacher.
- **Staff/admin record**: role/tier, whether disabled, who created/invited
  them.
- **Roster invitation**: connects a teacher-created student record to the
  eventual sign-in identity that will claim it.

## Edge Cases

- The same real person studies with two different teachers on the platform
  — they end up with two separate Student records (one per teacher), both
  eventually linked to the same sign-in identity, but each teacher only ever
  sees their own record/notes about that student.
- A teacher tries to also become a student (or a student tries to become a
  teacher) using the same email — blocked with a conflict message; the
  identity keeps whichever role it already had.
- A staff account is downgraded/disabled mid-session — subsequent admin
  actions should be blocked even though the browser/device still shows them
  "signed in" generally (their non-admin session isn't necessarily killed
  by a role change alone; the admin gate specifically re-checks role/2FA
  every time).
- Someone signs in for the first time with an email that matches an
  unclaimed Student record on more than one teacher's roster — only the
  oldest matching record gets linked; the others stay unclaimed under that
  identity.
- A staff member holds the narrow "Tester" or "Engineer" role — they get
  _no_ general admin access by rank at all, only whatever specific
  capabilities were explicitly granted to them.

## Error States

- "Teacher email conflict" — attempting to create/link the "other" role for
  an identity that already has one.
- "No account found" — signing in with an email that resolves to no role at
  all (and wasn't going through sign-up).
- Redirected to `/` (or app home) rather than shown an error — a signed-in
  identity with no linked student record hitting a student-only page bounces
  quietly to the general home rather than crashing or exposing another
  student's data.
- Redirected to the admin security/step-up screen — a staff identity without
  a fresh 2FA step-up hitting any admin page.
- Redirected to sign-in with the original destination remembered (teacher/
  admin paths) or to the plain home (student paths) — an unauthenticated hit
  on a protected route group.

## Permissions

| Action                                                     | Teacher                                                                                           | Student                 | Staff/Admin                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| View/edit own profile & settings                           | Yes (own only)                                                                                    | Yes (own only)          | Yes (own only)                                                                                                                                      |
| View/manage own roster & classes                           | Yes                                                                                               | N/A                     | View/manage across all teachers (admin tools)                                                                                                       |
| Book/pay for a class                                       | N/A (books for own students on their behalf is a separate teacher capability, not "as a student") | Yes (own bookings only) | N/A                                                                                                                                                 |
| View another teacher's dashboard/students                  | No                                                                                                | No                      | Yes, via admin tools, scoped by role tier                                                                                                           |
| View another student's data                                | No                                                                                                | No                      | Yes, via admin tools, scoped by role tier                                                                                                           |
| Access `/admin`                                            | No                                                                                                | No                      | Yes, subject to role tier + 2FA step-up                                                                                                             |
| Create/disable staff accounts                              | No                                                                                                | No                      | Yes (higher-tier roles only)                                                                                                                        |
| Approve/act on disputes, subscriptions, payments oversight | No                                                                                                | No                      | Yes, gated by role tier ("finance"/"superadmin" for most of these; "support" more limited; "tester"/"engineer" only via explicit capability grants) |

## Open Questions

- The exact, complete capability matrix for each staff tier (what
  "support" can do versus "finance" versus "superadmin" versus the
  capability-gated "tester"/"engineer" roles) was reviewed only at the
  permission-boundary level (`requireAdmin(minRole, capability)`), not
  feature-by-feature across the entire admin panel — a full capability
  matrix would need a dedicated pass over every admin route.
- Whether teachers can ever act "on behalf of" a student (e.g., manually
  booking a class for them) and how that is modeled from a
  role/permissions standpoint was not directly investigated in this pass.
