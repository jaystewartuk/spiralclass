# Incident response runbook

Checklist-shaped steps for a confirmed or suspected security or operational
incident. The prose is in [`../security.md`](../security.md); this file is
what to follow when there is no time to read it.

It is written in the plural — "the team", roles — and there is one maintainer.
Where a step names a role nobody holds, the operator holds it.

**If an incident is in progress, go to [§3](#3-the-phases).**

---

## 1. Severities

| SEV   | Trigger                                                          | Examples                                                                                        | Target response                     |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| SEV-0 | Confirmed crown-jewel breach or active data exfiltration         | A crown-jewel secret leaked publicly; payouts misrouted; mass account takeover                  | Start within 5 min; everyone online |
| SEV-1 | Suspected breach; broad outage; one credential confirmed exposed | A Stripe webhook secret committed to a public repo; Sentry shows a CSRF-style attack succeeding | Start within 15 min                 |
| SEV-2 | Targeted compromise of one or two accounts; partial outage       | One teacher's account taken over; one webhook source 503ing                                     | Acknowledge within 1 hour           |
| SEV-3 | Suspicious activity, no confirmed impact                         | A spike in failed sign-ins for one email; an oddly-shaped Sentry event                          | Triage within one business day      |

**Crown jewels:** `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`,
`INNGEST_SIGNING_KEY`, `RESEND_API_KEY`, the `DATABASE_URL` password,
`SESSION_SECRET`. Any of these on a public surface is an automatic SEV-0.

---

## 2. Roles

| Role               | Responsibilities                                              |
| ------------------ | ------------------------------------------------------------- |
| Incident commander | Drives the timeline; declares SEV; decides when to stand down |
| Tech lead          | Hands-on remediation                                          |
| Comms lead         | External messaging (teachers, students, regulator)            |
| Scribe             | Keeps the timeline — every action, every decision             |

For SEV-2 and SEV-3 one person can hold several roles. For SEV-0 and SEV-1,
when there is more than one person, the commander is not the tech lead — one
steers, one fixes.

---

## 3. The phases

### 3.1 Detect

Sources of signal, roughly fastest first:

- Sentry — the `surface` tag filters scope quickly.
- The external uptime monitor ([`RELEASE_AND_STAGING.md`](./RELEASE_AND_STAGING.md#cloud-run-serves-production-d-184)).
- A customer report by email or in-product feedback.
- A Stripe dashboard notification.
- A GitHub secret-scanning alert.
- A regulator inquiry. If this is the first signal, you are already behind —
  declare SEV-1 or higher and contact counsel.

### 3.2 Triage

1. Start a private timeline: every row `HH:MM UTC — actor — action`. Note the
   suspected SEV and who is commanding.
2. Confirm scope:
   - Which secret, table or endpoint is implicated?
   - When did it start? (Sentry, and the queries in [§6](#6-useful-queries).)
   - Is it still happening?
3. Declare the SEV. If unsure, round up — downgrading later costs nothing.

### 3.3 Contain

Stop the bleed; tidiness comes later.

- **A secret is confirmed exposed:** rotate it _now_ ([§4](#4-secret-rotation-playbook))
  before investigating further.
- **An account is compromised:** disable it from `/admin` (recorded in
  `overrides` as `disable_teacher` / `disable_student`).
- **A webhook endpoint is being abused:** pause it in the Stripe dashboard. Do
  not delete it; pausing is reversible.
- **A broad attack** (e.g. sign-ups being abused): tighten the window in
  `apps/web/src/lib/rate-limit.ts` and ship a hotfix, or put the app behind
  maintenance mode
  ([`RELEASE_AND_STAGING.md`](./RELEASE_AND_STAGING.md#maintenance-windows-taking-the-app-offline)).

If the production database is suspected compromised, do not delete data.
Snapshot first — a Neon branch from the console, or
`infra/database/scripts/neon-checkpoint.sh` — so the forensic record survives
the fix.

### 3.4 Eradicate

- Fix on a branch named `hotfix/inc-YYYYMMDD-{slug}`. A hotfix still goes
  through the gate; never `--no-verify`.
- Re-verify that the abused surface no longer accepts the abuse case. Replay
  the original signal — do not declare eradication on theory.

### 3.5 Recover

- Re-enable any paused surfaces (webhooks, accounts).
- Monitor for 72 hours: Sentry filtered on the relevant `surface` tag, and the
  logs for the affected table.
- Tell affected users ([§5](#5-notification-obligations)).

### 3.6 Post-mortem

Within 5 business days, write a blameless post-mortem:

- **Timeline** — from the scribe's notes, sanitized.
- **Root cause** — the actual bug or misconfiguration.
- **Contributing factors** — what let it land, or made it harder to detect or
  contain.
- **What changes** — specific. "Better monitoring" is not actionable; "alert
  when Stripe webhook signature failures exceed N a minute" is.
- **Follow-up actions** — each one an issue on this repository
  ([D-164](../decisions/D-164.md)), linked from the post-mortem. Anything that
  must not be public goes through [SECURITY.md](../../SECURITY.md)'s private
  channel instead.

---

## 4. Secret rotation playbook

Rotate _before_ you investigate when an exposure is plausible. An unnecessary
rotation costs minutes; a missed one costs the whole blast radius.

### 4.0 How a new value reaches production

Every step below that says **apply it** means this, all of it the operator's:

1. Set the new value in Infisical `production` at `/`.
2. Run `infra/gcp/push-cloudrun-env.sh <project-id>`. It rewrites Cloud Run's
   one runtime secret as a new version — the whole set, not one key.
3. Deploy, so a new revision mounts that version — approve a release, or
   `pnpm deploy:cloudrun` by hand. **A running revision keeps the version it
   started with**, so nothing changes until this step.

### 4.1 `STRIPE_SECRET_KEY`

1. Stripe dashboard → Developers → API keys → roll the live secret key.
2. Apply `STRIPE_SECRET_KEY` (§4.0).
3. Revoke the old key once the new revision is serving.

Downstream impact: in-flight Checkout sessions complete on the new key
because Stripe re-fetches via the platform credentials. Refunds in progress
may need to be retried.

### 4.2 The Stripe webhook signing secrets

There are three, one per endpoint: `STRIPE_WEBHOOK_SECRET` (platform events),
`STRIPE_CONNECT_WEBHOOK_SECRET` (connected-account events) and
`STRIPE_BILLING_WEBHOOK_SECRET` (subscription billing). For the exposed one:

1. Stripe dashboard → Developers → Webhooks → the endpoint → roll the signing
   secret.
2. Stripe shows the old and new secrets for a 24h overlap window.
3. Apply the new value (§4.0) inside that window — then there is no downtime.

### 4.3 `INNGEST_SIGNING_KEY` / `INNGEST_EVENT_KEY`

1. Inngest dashboard → the production environment → roll the keys.
2. Apply `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` (§4.0).

### 4.4 `RESEND_API_KEY`

1. Resend dashboard → API Keys → revoke and create.
2. Apply `RESEND_API_KEY` (§4.0). Outbound email resumes once the new revision
   is serving.

### 4.5 `SESSION_SECRET`

1. Generate: `openssl rand -base64 32`.
2. Apply `SESSION_SECRET` (§4.0).
3. **What it invalidates:** it is the HMAC key for capability tokens, not for
   sign-in sessions. Every outstanding email unsubscribe and
   notification-settings link stops verifying, a Google Calendar connection in
   progress must be restarted, and every admin must redo the TOTP step-up.
   Stored visitor-id hashes (`apps/web/src/lib/marketing/visitor.ts`) stop
   matching new visits, so attribution starts a new series. Signed-in users
   stay signed in; calendar feed URLs are random per-user tokens and are
   unaffected.

### 4.6 `DATABASE_URL` / `DIRECT_URL` password

1. Neon console → the production project → Roles → reset the role's password.
2. Apply the new `DATABASE_URL` and `DIRECT_URL` (§4.0) _and_ re-sync the
   `production` GitHub environment (`infra/infisical/push-github-secrets.sh`),
   which the deploy's `database` job reads.
3. The app cannot connect from the reset until a revision carrying the new
   value is serving, and that deploy includes an image build — expect 5xx for
   the whole window, and have step 2 ready before you reset.

### 4.7 `BETTER_AUTH_SECRET`

1. Generate: `openssl rand -base64 32`.
2. Apply `BETTER_AUTH_SECRET` (§4.0).
3. **All sessions are invalidated** — better-auth signs session tokens with it,
   so every teacher and student is signed out. Coordinate comms first unless
   it is an active SEV-0/1.
4. Confirm with a fresh magic-link sign-in before standing down — a bad value
   fails closed (nobody can sign in), not open.

---

## 5. Notification obligations

> [!WARNING]
> **Who must be told, on what clock, is not recorded in this repository**
> ([D-158](../decisions/D-158.md)). Establish it before an incident, not during
> one.

Keep the contact address on `/privacy-notice` routed to a human who can pick up
urgent mail. When notifying anyone, say plainly what happened, what data was
affected, what is being done, and what the recipient should do.

**Stripe (payment-related):** notify Stripe within 24 hours via the Connect
dashboard or `disputes@stripe.com`. Stripe's terms require prompt notice of any
event affecting cardholder data, even though the platform's PCI scope is SAQ A
and it never handles card numbers.

---

## 6. Useful queries

Run with `psql` against the production `DIRECT_URL`.

### 6.1 Recent sign-ins for one email

Auth is better-auth on Prisma; its tables are `user` and `session`. One
`session` row is one successful sign-in. Failed attempts are not stored —
look in Sentry and the rate limiter.

```sql
SELECT u.email, u."emailVerified", u."createdAt" AS account_created_at,
       s."createdAt" AS session_created_at, s."ipAddress", s."userAgent"
FROM "user" u
JOIN "session" s ON s."userId" = u.id
WHERE u.email = '...'
ORDER BY s."createdAt" DESC
LIMIT 5;
```

### 6.2 Admin actions in a window

```sql
SELECT created_at, teacher_id, target_type, target_id, action, reason
FROM overrides
WHERE created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

### 6.3 Payments created, paid or refunded recently

```sql
SELECT id, status, provider, amount_minor_units, created_at, paid_at, refunded_at
FROM payments
WHERE greatest(created_at, paid_at, refunded_at) >= now() - interval '6 hours'
ORDER BY greatest(created_at, paid_at, refunded_at) DESC
LIMIT 50;
```

### 6.4 Webhook events received

```sql
SELECT received_at, provider, event_type, event_id
FROM webhook_events
WHERE received_at >= now() - interval '1 hour'
ORDER BY received_at DESC
LIMIT 50;
```

### 6.5 Notifications failing for a recipient

```sql
SELECT created_at, channel, template_name, status, error
FROM notifications
WHERE recipient_id = '...' AND status = 'failed'
ORDER BY created_at DESC
LIMIT 20;
```

---

## 7. Contacts

Kept privately, never committed: the support contacts for Neon, Google Cloud
and Stripe, and a legal contact for breach-notification guidance.
