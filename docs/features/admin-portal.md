# Admin Portal

## Overview

The Admin Portal is SpiralClass's internal operator surface — used by the
platform's own staff (not teachers, not students) to run the business:
customer support, financial operations, payment-dispute handling, platform
economics/cost tracking, notification-health monitoring, and pre-release QA.

It lives at `apps/web/src/app/admin/**`, organised into a sidebar with five
sections (Overview, People, Money, Operations, Admin).

Access is entirely separate from the Teacher and Student product surfaces: an
operator is not a Teacher or Student row, but a row in `AdminUser`.

## User Stories

- As a **support** staff member, I want to look up a teacher or student by
  name/email/slug so I can answer a "why isn't this working" ticket without
  needing database access.
- As a **support** staff member, I want to disable a disruptive or abusive
  teacher/student account so they can't use the platform, and re-enable one
  once the issue is resolved.
- As a **finance** staff member, I want to see all payments, refund one when
  a student was wrongly charged, see subscription/billing state per teacher,
  and comp a teacher onto a paid plan (e.g. for a partnership).

* As a **finance** staff member, I want visibility into open Stripe disputes
  (chargebacks) so nothing misses its evidence deadline.

- As a **superadmin**, I want to invite new staff, assign their role, and
  disable a departing staff member's admin access.
- As a **superadmin**, I want to run a UAT (User Acceptance Testing) checklist
  against preview or production before/after a risky change, and have my
  progress persist across a session.
- As a **superadmin**, I want to see the platform's cost base (vendor
  expenses, usage-driven estimates, FX assumptions) blended against revenue
  to understand real unit economics, independent of the cash-flow dashboard.

## Business Rules (exhaustive)

### Identity and role model

- An operator is authorized via the `AdminUser` table: `{ email, role,
disabledAt }`. `role` is one of `superadmin`, `finance`, `support`,
  `tester`, `engineer` (Prisma enum `AdminRole`).
- Role **rank** (descending privilege): `superadmin` (3) > `finance` (2) >
  `support` (1). `tester` and `engineer` rank at **0** — below `support` —
  deliberately: they never gain access via the rank ladder, only via an
  explicit **capability** grant (see below).
- **Capabilities** are a second, orthogonal grant, independent of rank:
  `uat:run` (run the UAT checklist tool) and `schema:view` (view the
  read-only DB schema/ERD). `superadmin` implicitly holds every capability.
  `tester` holds `uat:run`. `engineer` holds `uat:run` + `schema:view`.
  `finance` and `support` hold neither by default.
- A page/action's gate is expressed as "minimum role, OR this capability" —
  e.g. the UAT tool requires `superadmin` rank OR the `uat:run` capability,
  which is how the narrow `tester` role reaches exactly that one tool.
- **Env-allowlist bootstrap**: on a fresh database with zero `AdminUser` rows,
  any email listed in `SUPERUSER_EMAILS` (env var, merged with a hardcoded
  `BUILTIN_SUPERUSERS` set — currently empty) is treated as a synthetic
  `superadmin` with an unattributed identity (audit rows can't attribute
  actions to it — `actorAdminId` is `NULL`). This path is meant to be
  transient: the intended flow is to seed one real `AdminUser` row via
  `/admin/staff`, after which the bootstrap allowlist should be cleared. As
  long as `AdminUser` has zero rows, the bootstrap remains active.
- A disabled `AdminUser` row (`disabledAt` set) loses all admin access
  immediately, regardless of role.
- **Mandatory MFA (web)**: every admin page/action requires (1) TOTP
  enrolled (`user.twoFactorEnabled`) AND (2) a fresh, session-bound
  "step-up" — the admin must have actually presented a TOTP code in this
  session recently, not just have MFA enrolled at some point in the past.
  There is no opt-out, for any role tier. Failing either check redirects to
  `/admin/security`, the one admin page reachable without this check (to
  avoid a redirect loop on the page that grants the step-up).
- Staff emails are excluded from "teacher" listings/filters shown elsewhere
  in admin (e.g. Students/Audit "filter by teacher" dropdowns) — a staff
  member's own dev/test session can auto-create a real `Teacher` row via
  ordinary product use, and that shouldn't masquerade as a real teacher in
  admin views.

### Section/page role floors (web) — as coded today

- **Overview** (`/admin`) — any admin tier (`support` floor).
- **People**: Teachers (`support`), Students (`superadmin` — note: stricter
  than Teachers; see Open Questions), Teacher/Student detail pages inherit
  their list's floor.
- **Money**: Payments (`finance`), Money/cash-flow (`finance`), Costs
  (`finance`), Economics (`finance`), Packages (`support`), Subscriptions
  (`finance`).
- **Operations**: Disputes (`superadmin` — note: page requires superadmin
  even though sidebar visibility is set at `finance`; see Open Questions),
  Notifications (`support`), Lesson Insights (`superadmin`), Audit Log
  (`superadmin` — same sidebar/page mismatch), Live Calls (`support`),
  Integrations (`superadmin` — same mismatch).
- **Admin**: Storage (`superadmin`), Database/ERD (`superadmin` +
  `schema:view` capability), UAT Tools (`superadmin` + `uat:run`
  capability), Staff (`superadmin`).

### Teacher/Student moderation

- A **support**-or-above operator can **disable** a Teacher or Student
  account. Disabling requires typing a free-text reason (kept on record,
  not just a boolean flip) and is confirmed via a destructive-action dialog.
- A disabled Teacher/Student loses access immediately:
  `teacher.disabledAt`/`student.disabledAt` block the session on its next
  request.
- **Re-enabling** a disabled account requires no reason — a single-click
  confirm.
- Only for teachers: a **resend magic-link** action exists (re-sends the
  teacher's passwordless sign-in link), independent of the disable/enable
  toggle.

### Packages (admin)

- **Cancel a package**: requires a free-text reason (kept on record, max
  280 chars), and is a one-way action once submitted (already-refunded
  packages show a static "already refunded" state instead of the cancel
  form).
- **Extend a package's expiration**: only offered when the package actually
  has an expiry (`hasExpiry`); extend by a whole number of months (1–24).

### Subscriptions (Teacher billing state, admin view)

- An operator can put a teacher on a **comped** plan (`monthly`, `annual`,
  or `founding` — free, staff-granted) or record a **paid** plan alongside a
  manually-entered amount/Wise reference (used when a teacher pays via Wise
  rather than Stripe Billing, which this UI reconciles by hand).
- This is a completely separate mechanism from the teacher-facing Stripe
  Billing checkout described in `docs/features/subscriptions.md` — it's the
  admin-side override/reconciliation path, not a new billing rail.

### Disputes (Stripe chargebacks)

- One row (`Dispute`) per Stripe dispute (`dp_*`), upserted by the Stripe
  webhook handler — **not created or edited from admin UI**; the admin
  disputes screens are **read-only** surfaces over data Stripe pushes in. There is no in-app "respond to dispute" or "submit
  evidence" action — evidence submission happens in the Stripe dashboard
  directly.
- Status values (`DisputeStatus`): `warning_needs_response`,
  `warning_under_review`, `warning_closed`, `needs_response`,
  `under_review`, `charge_refunded`, `won`, `lost`.
- `isFinal` marks a dispute as resolved (won/lost/charge_refunded/
  warning_closed) vs. still active. The admin sidebar surfaces a live count of
  **not-final, `needs_response`** disputes as a badge, so an operator sees at a glance when a chargeback needs attention
  before its Stripe evidence deadline (`evidenceDueBy`) passes.
- A dispute may be **unmatched** to a local `Payment` row (`paymentId` null)
  — e.g. a charge from outside the normal booking flow. Unmatched disputes
  are still shown, flagged distinctly ("unmatched"), never hidden.

### Economics / cost tracking (`finance` floor)

- `PlatformExpense`: one manually-entered row per vendor cost per calendar
  month (native billing currency — the estimate layer only blends MXN rows
  into net-profit totals today; there's no live FX feed, so non-MXN rows are
  surfaced separately rather than silently converted).
- `Integration`: a registry of third-party vendors (Stripe, Vercel/Fly,
  Anthropic, GitHub, etc.) with a `pricingModel` (JSON) describing how their
  cost is computed, independent of any actual monthly expense entry.
- `UsageInput`: one manually-entered metered reading per usage metric per
  month (e.g. minutes of video calls, emails sent) — the input the pricing
  engine multiplies against each integration's `pricingModel` to estimate a
  cost without a real vendor invoice yet existing.
- `EconomicsAssumptions`: a **singleton** row (`id = "default"`) holding
  manually-maintained FX rates (USD/MXN/EUR → GBP — GBP is the owner's
  money-of-record here per D-58) and a cost-allocation basis (default:
  `active_teachers`), plus an `fxAsOf` marker so the UI can show "FX as of
  {date}" rather than implying a live feed.
- This is a distinct system from the Cash-Flow dashboard
  (`docs/product/` / `project_cashflow_dashboard_decision`) — economics
  blends estimated _costs_ against revenue for unit economics; cash-flow is
  about earned-vs-held/safe-to-spend from real Payment rows. Don't conflate
  the two when reasoning about "the money page."

### UAT checklist tool (`superadmin` + `uat:run`, web only)

- `UatChecklistState`: one row per target environment (`preview`,
  `production`), storing which checklist items are currently checked
  (`checkedItems`, a JSON array) and who last touched it.
- This is an **ephemeral run-tracker**, not an audit record — if the
  runbook's checklist items are ever reordered, the stored checked-state
  (keyed by document-order index) just resets harmlessly; it is not treated
  as a historical compliance log. The real audit trail for the actions the
  runbook triggers (probe, reseed, PostHog check, Stripe check) is the
  `Override` rows those actions write via the audit-log mechanism.

### Staff management (`superadmin` only)

- Only a `superadmin` can invite new staff (creating an `AdminUser` row with
  a chosen role) or disable an existing staff member's access.
- `AdminUser.createdById` self-references `AdminUser` (who invited whom),
  giving a staff-invitation lineage.

### Alpha allowlist (schema exists; **not wired to any code path today**)

- `AlphaAllowlistEntry` (`email`, `addedBy`, `note`) exists as a Prisma model
  and is present in the applied migration/generated schema, but a
  repo-wide search found **no code that reads or writes this table** —
  no signup gate, no admin UI page, no API route references it. See Open
  Questions.

## User Flow (step by step)

**Reaching the portal (web):**

1. Operator signs in via the ordinary passwordless email-OTP flow (same
   auth as teachers/students — there is no separate admin login).
2. Navigating to `/admin` resolves the signed-in email against `AdminUser`
   (or the env bootstrap allowlist on an empty table). No row/email match →
   redirected to `/`.
3. If TOTP isn't enrolled, or this session hasn't presented a fresh TOTP
   code, redirected to `/admin/security` to enroll/step up.
4. Once authorized + stepped-up, the sidebar renders only the sections/links
   the operator's role (or capability) clears.

**Disabling a teacher:**

1. Operator opens the teacher's detail page.
2. Clicks "Disable"; a dialog demands a free-text reason.
3. On submit, `teacher.disabledAt` is set; every existing session for that
   teacher is locked out on its next request.
4. To restore access, operator clicks "Re-enable" (no reason required).

**Running the UAT checklist (web, superadmin/tester/engineer):**

1. Operator opens `/admin/uat`, picks target environment (preview or
   production).
2. Checks off items as each is verified; state autosaves per item to
   `UatChecklistState` for that environment, attributed to the admin.
3. Reopening later (even a different device/session) restores exactly what
   was checked.

## Data Used (business-level entities)

- `AdminUser` — staff identity + role + enable/disable state + invitation
  lineage.
- `AlphaAllowlistEntry` — schema present, unused (see above).
- `UatChecklistState` — per-environment UAT run progress.
- `Dispute` — Stripe chargebacks, read-only mirror.
- `EconomicsAssumptions` — singleton FX + allocation config.
- `PlatformExpense` — monthly vendor cost entries.
- `UsageInput` — monthly usage-metric readings.
- `Integration` — vendor registry + pricing model.
- `Teacher`, `Student` — the entities being viewed/moderated (disable/enable,
  contact edits, subscription overrides).
- `Package`, `Payment`, `TeacherSubscription` — money-side entities admin
  can view and, for packages/subscriptions, mutate directly.
- `Notification` — platform-wide delivery health (queued/failed counts
  surfaced as a sidebar badge).
- `Override` — the audit-log entity every admin mutation writes to.

## Edge Cases

- **Fresh database, zero staff rows**: the env-allowlist bootstrap is the
  only way in; every action taken this way is unattributed in the audit
  log (`actorAdminId = NULL`). Operators should seed a real `AdminUser` row
  via `/admin/staff` as soon as possible and then blank `SUPERUSER_EMAILS`
  in production so the backdoor can't re-arm if rows are later deleted.
- **Package with no expiry**: the "extend expiration" action is unavailable
  entirely (there's nothing to extend) rather than shown disabled.
- **Package already refunded**: the "cancel" action is replaced by a static
  message rather than allowing a second, meaningless cancel.
- **Unmatched dispute** (no local `Payment` match): still shown, flagged as
  "unmatched" rather than hidden — the amount/currency/reason still display
  from Stripe's own payload.
- **Non-MXN platform expense row**: excluded from the blended net-profit
  total shown by the Economics view (no live FX conversion exists for it),
  but the row itself is still visible in the underlying costs list.
- **Re-ordering the UAT runbook's checklist items**: silently resets the
  "checked" state for that reordered position (index-keyed, not
  item-identity-keyed) — treated as an accepted, harmless side effect, not a
  bug to fix.
- **Staff member also has a real Teacher account** (their own dev/test
  session touched a teacher page): they're excluded from admin's
  teacher-facing lists/filters so they don't show up looking like a genuine
  customer.

## Error States

- Unauthenticated visit to any `/admin/*` route → redirect to
  `/sign-in?next=/admin`.
- Authenticated but no `AdminUser` row (and bootstrap not applicable) →
  redirect to `/` (silently — no "access denied" page shown at this layer).
- Authenticated, has a row, but role/capability doesn't clear a specific
  page's floor → redirect to `/admin?error=forbidden` (an error banner on
  the Overview page).
- MFA not enrolled, or enrolled but no fresh step-up this session →
  redirect to `/admin/security`.
- Disabled `AdminUser` row → treated identically to "no row" (redirect to
  `/`), regardless of what role they used to hold.

## Permissions (view / create / edit / delete / approve / cancel by role)

| Capability                                           | support                                       | finance | superadmin | tester                                | engineer        |
| ---------------------------------------------------- | --------------------------------------------- | ------- | ---------- | ------------------------------------- | --------------- |
| View Overview                                        | ✅                                            | ✅      | ✅         | ❌ (no rank; no capability grants it) | ❌              |
| View/moderate Teachers                               | ✅                                            | ✅      | ✅         | ❌                                    | ❌              |
| View/moderate Students                               | ❌ (page requires superadmin despite sidebar) | ❌      | ✅         | ❌                                    | ❌              |
| View Payments                                        | ❌                                            | ✅      | ✅         | ❌                                    | ❌              |
| Refund a payment                                     | ❌                                            | ✅      | ✅         | ❌                                    | ❌              |
| View Money/cash-flow                                 | ❌                                            | ✅      | ✅         | ❌                                    | ❌              |
| View/edit Costs (PlatformExpense)                    | ❌                                            | ✅      | ✅         | ❌                                    | ❌              |
| View/edit Economics (assumptions/usage/integrations) | ❌                                            | ✅      | ✅         | ❌                                    | ❌              |
| View/cancel/extend Packages                          | ✅                                            | ✅      | ✅         | ❌                                    | ❌              |
| View/edit Subscriptions (comp/paid override)         | ❌                                            | ✅      | ✅         | ❌                                    | ❌              |
| View Disputes                                        | ❌ (page actually requires superadmin)        | ❌      | ✅         | ❌                                    | ❌              |
| View Notifications / retry a failed send             | ✅                                            | ✅      | ✅         | ❌                                    | ❌              |
| View Lesson Insights                                 | ❌                                            | ❌      | ✅         | ❌                                    | ❌              |
| View Audit Log                                       | ❌ (page actually requires superadmin)        | ❌      | ✅         | ❌                                    | ❌              |
| View Live Calls                                      | ✅                                            | ✅      | ✅         | ❌                                    | ❌              |
| View Integrations                                    | ❌ (page actually requires superadmin)        | ❌      | ✅         | ❌                                    | ❌              |
| View Storage browser                                 | ❌                                            | ❌      | ✅         | ❌                                    | ❌              |
| View Database/ERD                                    | ❌                                            | ❌      | ✅         | ❌                                    | ✅ (capability) |
| Run UAT checklist                                    | ❌                                            | ❌      | ✅         | ✅ (capability)                       | ✅ (capability) |
| Invite/disable staff                                 | ❌                                            | ❌      | ✅         | ❌                                    | ❌              |

Notes:

- "❌ (page actually requires superadmin despite sidebar)" rows mean: the
  sidebar link is shown to that role (per `admin-sidebar`/`layout.tsx`'s
  `minRole`), but clicking through redirects with `?error=forbidden`
  because the page itself calls `requireSuperuser()`. This is a real,
  present-day inconsistency — see Open Questions.
- **Approve/cancel** actions in this domain are: disable/re-enable
  (Teacher, Student), cancel/extend (Package), comp/paid-override
  (Subscription), retry (failed Notification). There is no "approve" verb
  anywhere in this domain — every mutation is either an immediate action or
  a moderation toggle, never a queued request awaiting a second approver.

## Open Questions

- **Sidebar-vs-page role mismatch (Disputes, Audit Log, Students,
  Integrations)**: the web sidebar (`layout.tsx` `NAV`) shows these links to
  `support`/`finance` roles, but the pages themselves call
  `requireSuperuser()`. A `support` or `finance` operator can see "Students"
  and "Disputes" in their nav and get bounced with a forbidden error on
  click. Is this an intentional "visible but locked" UX (e.g. so support
  staff know the surface exists and to ask a superadmin), or an
  unintentional drift where the page's gate was tightened after the sidebar
  entry was added? Recommend explicitly confirming before "fixing" either
  side.
- **Two independent admin mechanisms remain**, and they are not the same
  thing: the `AdminUser` table (capability-scoped staff, invited through
  `/admin/staff`) and the `SUPERUSER_EMAILS` env allowlist. The built-in
  allowlist constant is empty, so it cannot re-arm itself if rows are added
  later — but a superadmin invited purely as a database row and a superuser
  named purely in the environment are authorised by different code. Worth
  keeping in view when changing either.
- **`AlphaAllowlistEntry` is fully unused**: the model + migration exist,
  but no signup flow, admin page, or API route reads/writes it anywhere in
  the current codebase. Is this dead schema left over from a removed
  feature (should be dropped in a future migration), or a placeholder for
  a not-yet-built alpha-gating feature? Do not assume it currently gates
  anything — it does not.
- **`Dispute` has no in-app resolution workflow**: is evidence submission
  and status transition intentionally Stripe-dashboard-only forever, or is
  an in-app "submit evidence" / "mark as escalated" action planned? The
  current admin screens are strictly read-only for this
  entity.
- **Students require `superadmin` while Teachers only require `support`**:
  is this a deliberate stricter-PII stance on student data specifically
  (students include minors in some cases), or an oversight? Worth
  confirming rather than assuming either reading.
