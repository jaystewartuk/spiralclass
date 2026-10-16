# Admin Portal

The operator console for platform staff: support look-ups and moderation,
payments and refunds, subscription overrides, disputes, cost and unit
economics, notification health, live calls, and pre-release QA. It lives at
`apps/web/src/app/admin/**`, in a sidebar of five sections (Overview, People,
Money, Operations, Admin). An operator is an `AdminUser` row, never a Teacher or
Student.

## Identity, roles and capabilities

- `AdminUser` holds `{ email, role, disabledAt, createdById }`. `role` is the
  `AdminRole` enum: `superadmin`, `finance`, `support`, `tester`, `engineer`.
  `createdById` records who invited whom.
- **Rank** (`ROLE_RANK`, `lib/admin.ts`): `superadmin` 3 > `finance` 2 >
  `support` 1; `tester` and `engineer` are 0, so they never clear a role floor.
- **Capabilities** (`lib/admin-capabilities.ts`, [D-25](../decisions/D-25.md))
  are a second grant, independent of rank: `uat:run` and `schema:view`.
  `superadmin` holds all; `tester` holds `uat:run`; `engineer` holds `uat:run`
  and `schema:view`; `finance` and `support` hold none.
- A gate is `requireAdmin(minRole, capability?)` — the role floor **or** the
  capability. `requireSuperuser()` is `requireAdmin("superadmin")`.
- A disabled `AdminUser` is treated as no row.
- **Bootstrap.** While `admin_users` is empty, an email in `SUPERUSER_EMAILS`
  (merged with `BUILTIN_SUPERUSERS`, which is empty) is a synthetic
  superadmin. Its audit rows have `actorAdminId = NULL`, and each use logs a
  warning and tags Sentry. Seed a real row from `/admin/staff`, then blank
  `SUPERUSER_EMAILS` in production so it cannot re-arm. One real row switches
  the bootstrap off.
- **Mandatory MFA, no opt-out.** Every admin page and action requires TOTP to
  be enrolled **and** a fresh step-up in this session (12 hours,
  `ADMIN_STEPUP_TTL_MS`). Either missing redirects to `/admin/security`, the one
  page gated only on "is an admin" so it can grant the step-up. See
  [authentication](authentication.md#admin-two-factor-and-step-up).
- Staff emails are left out of the "filter by teacher" lists elsewhere in
  admin, because a staff member's own product use can create a real `Teacher`
  row.

## Page floors

What the page itself requires, from its `requireAdmin` call. The sidebar's own
`minRole` (`NAV` in `app/admin/layout.tsx`) is lower for four pages — marked
†: the link shows, and the page redirects to `/admin?error=forbidden`.

| Section    | Page                       | Page requires                 | Sidebar shows from |
| ---------- | -------------------------- | ----------------------------- | ------------------ |
| Overview   | `/admin`                   | any admin                     | `support`          |
| People     | `/admin/teachers`          | `support`                     | `support`          |
| People     | `/admin/students` †        | `superadmin`                  | `support`          |
| Money      | `/admin/payments`          | `finance`                     | `finance`          |
| Money      | `/admin/money` (cash flow) | `finance`                     | `finance`          |
| Money      | `/admin/costs`             | `finance`                     | `finance`          |
| Money      | `/admin/economics`         | `finance`                     | `finance`          |
| Money      | `/admin/packages`          | `support`                     | `support`          |
| Money      | `/admin/subscriptions`     | `finance`                     | `finance`          |
| Operations | `/admin/disputes` †        | `superadmin`                  | `finance`          |
| Operations | `/admin/notifications`     | `support`                     | `support`          |
| Operations | `/admin/lesson-insights`   | `superadmin`                  | `superadmin`       |
| Operations | `/admin/audit` †           | `superadmin`                  | `support`          |
| Operations | `/admin/live-calls`        | `support`                     | `support`          |
| Operations | `/admin/integrations` †    | `superadmin`                  | `support`          |
| Admin      | `/admin/storage`           | `superadmin`                  | `superadmin`       |
| Admin      | `/admin/database` (ERD)    | `superadmin` or `schema:view` | same               |
| Admin      | `/admin/uat`               | `superadmin` or `uat:run`     | same               |
| Admin      | `/admin/staff`             | `superadmin`                  | `superadmin`       |

The student **actions** (`app/actions/admin-students.ts`: disable, enable,
change email) require only `support`, so a support operator can call them but
cannot open the page that offers them. Whether the stricter page floor on
students is deliberate is not recorded anywhere; confirm before changing
either side.

## Moderation

- `support`+ can **disable** a teacher or student, with a required free-text
  reason and a destructive-action confirm. The session is refused on its next
  request. **Re-enabling** needs no reason.
- Teachers only: **resend magic link**.
- Students only: **change email** for a student who lost her old inbox, after
  out-of-band identity checks. It moves the auth identity and the student
  rows together, disconnects Google and signs out every session — see
  [authentication](authentication.md#changing-the-sign-in-email).

### Test accounts

- `support`+ can mark or unmark a teacher or student as a **test account**
  (`setTestAccountAction`). A reason is required either way, and the change is
  audited.
- It changes no access, booking, payment or entitlement. It decides which
  figures the account counts in:
  - **Platform totals** leave test teachers and test students out.
  - **A real teacher** sees a test student listed and marked, but left out of
    her earnings, paid in advance and roster figures.
  - **A test teacher** sees everything.
- Test in a test teacher. When a real teacher's live page has to be tested as
  a buyer, mark that student first, and refund the charge after.
- The flag is set **only** by that admin action — never self-serve, by a
  teacher, a student or an API handler, and never inferred. It never gates
  sign-in, booking, payment or entitlements, and never hides or deletes rows.
  It is not `comped`, which is billing.
- A row is also treated as a test account if it matches the **shape** rule
  (`RESERVED_SLUG_PREFIXES`, and `.test` / `@example.com` emails).
- **One definition.** Every figure over teachers, students, packages, bookings
  or payments takes its exclusion from `apps/web/src/lib/marketing/test-accounts.ts`
  — `realStudentsOf(teacher)` for one teacher's figures, `REAL_PACKAGE_WHERE` /
  `NOT_TEST_ACCOUNT` for platform roll-ups. Nothing enforces this
  mechanically, so a new figure must remember it.
- Not yet excluded: admin CSV exports, the ledger's monthly received
  subtotals, the commission report and Wise renewals.
- PostHog receives an `is_test_account` person property from the server and
  client identify calls; earlier events are not rewritten.

## Money

- **Payments** (`finance`): list and refund (`adminRefundPaymentAction`).
  Refund rules are in [payments](payments.md).
- **Packages** (`support`): cancel with a required reason (≤ 280 characters);
  an already-refunded package shows a static notice instead. Extend the expiry
  by 1–24 whole months, with a reason, only when the package has one.
- **Subscriptions** (`finance`): put a teacher on a **comped** plan (`monthly`,
  `annual` or `founding`), or record a **paid** plan by hand with an amount and
  an optional payment reference (≤ 120 characters) for a teacher paying outside
  Stripe Billing. This is an override and reconciliation path, not a billing
  rail; billing itself is [subscriptions](subscriptions.md).

### Disputes

- One `Dispute` row per Stripe dispute (`dp_*`), upserted by the payments
  webhook (`lib/payments/webhook-handler.ts`). Admin screens are read-only:
  evidence is submitted in Stripe's dashboard. What a lost dispute does to the
  student's classes is in [payments](payments.md).
- Status is `DisputeStatus`: `warning_needs_response`, `warning_under_review`,
  `warning_closed`, `needs_response`, `under_review`, `charge_refunded`,
  `won`, `lost`.
- `isFinal` is set for `won`, `lost`, `warning_closed`, or when Stripe reports
  the charge no longer refundable.
- The sidebar badge counts disputes with `isFinal = false` and
  `status = needs_response`, so one is seen before `evidenceDueBy`.
- A dispute with no matching `Payment` (`paymentId` null) is shown flagged
  "unmatched", never hidden.

### Costs and unit economics

Two separate systems; do not blend them.

- **Actuals** (`/admin/costs`, `/admin/money`): `PlatformExpense`, one
  hand-entered row per vendor cost per month, in its billing currency.
  Expense series and net profit total only rows in `PLATFORM_MONEY_CURRENCY`
  (GBP, `packages/shared/src/platform-regions.ts`); other currencies are listed
  separately, never converted. Cash flow is built from real `Payment` rows.
- **Estimates** (`/admin/economics`): the estimate layer.
  - `Integration` is a vendor registry seeded from `KNOWN_INTEGRATIONS`
    (`packages/shared/src/economics-config.ts`, create-if-absent so an admin's
    edits survive a reseed). Each row's `pricingModel` JSON says how its cost
    is computed.
  - `UsageInput` is one hand-entered metered reading per metric per month.
  - `EconomicsAssumptions` is a singleton (`id = "default"`): USD, MXN and EUR
    → GBP rates, an allocation basis (default `active_teachers`) and `fxAsOf`,
    so the UI says "FX as of" instead of implying a live feed.
  - **Pricing is data, not code**: one generic engine
    (`packages/shared/src/economics-pricing.ts`) with no per-provider branches,
    so adding an integration needs no migration and no code. Integration
    categories are a shared constant, not the actuals' `ExpenseCategory` enum.
    Estimates are never written into or blended with the actuals. FX is an
    explicit, dated, admin-edited assumption, and an integration that cannot be
    priced (bad JSON, unknown currency) contributes £0 with a visible warning
    instead of failing the page.
- `EconomicsAssumptions` also feeds the approximate-USD hint on the public buy
  page (`apps/web/src/lib/pricing/approx-usd.ts`), which stops rendering once
  the rates are more than 60 days old (`APPROX_MAX_AGE_DAYS`) — so a rate set
  for the P&L moves what buyers see.

## Operations

- **Notifications** (`support`): delivery health; the sidebar badge counts
  `failed` notifications. Retry a failed send (`support`); send a broadcast
  (`superadmin`).
- **Lesson insights** (`superadmin`): pipeline counts and stage timestamps
  only, never content — see [lesson insights](lesson-insights-reports.md).
- **Live calls** (`support`): live LiveKit rooms; end a room or disconnect a
  participant.
- **Audit log** (`superadmin`): every admin mutation writes an `Override` row
  through `writeOverride` (`lib/audit.ts`).

## Admin tools

- **Staff** (`superadmin`): invite (create an `AdminUser` with a role) and
  disable staff.
- **UAT checklist** (`superadmin` or `uat:run`): the steps are
  `UAT_SECTIONS` in `lib/uat/runbook-steps.ts`, with automated probe, PostHog
  and Stripe checks and a preview reseed. `UatChecklistState` keeps one row per
  target environment (`preview`, `production`) holding the checked item ids
  and who last changed it, so progress survives a new device or session. It is
  a run-tracker, not an audit record; the automated actions write `Override`
  rows.
- **Storage** (`superadmin`): an R2 browser. **Database** (`superadmin` or
  `schema:view`): a read-only ERD.

`AlphaAllowlistEntry` exists in the schema and is written only by the fixture
seed (`apps/web/scripts/seed-fixtures.ts`); no application code reads it, so
sign-up is not allowlist-gated.

## Reaching the portal

1. Sign in the ordinary way (email code or Google); there is no separate admin
   login. A staff email is sent to `/admin` after sign-in.
2. Not signed in → `/sign-in?next=/admin`. No `AdminUser` row (and no
   bootstrap) or a disabled one → `/`, silently.
3. No TOTP, or no fresh step-up → `/admin/security`.
4. A page whose floor the operator does not clear → `/admin?error=forbidden`.
5. The sidebar shows only the links the operator's role or capability clears.

No admin action is a request awaiting a second approver: every mutation is
immediate and audited.
