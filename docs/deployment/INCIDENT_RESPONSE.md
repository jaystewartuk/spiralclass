# Incident Response Runbook

_Companion to [`../security.md`](../security.md), which carries the prose. Keep
this one to hand: the first time it is needed there will be no time to find it._

_⚠️ It is written in the plural — "page on-call", "the team" — and there is one
maintainer. That is deliberate. The severities and the ordering are what a
person following this at 3am needs, and rewriting them into the singular would
be the only change; where a step names a role nobody holds, the operator holds
it._

This runbook covers the operational steps for handling a confirmed or
suspected security incident. It is intentionally checklist-shaped — keep
the prose in [`../security.md`](../security.md).

If you are reading this while an incident is in progress, scroll to §3.

---

## 1. Severities

| SEV   | Trigger                                                          | Examples                                                                                      | Target response                             |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| SEV-0 | Confirmed crown-jewel breach or active data exfiltration         | Service-role key leaked publicly; payouts misrouted; mass account takeover                    | Page on-call within 5 min; full team online |
| SEV-1 | Suspected breach; broad outage; one credential confirmed exposed | Stripe webhook secret committed to a public repo; Sentry shows a CSRF-style attack succeeding | Page on-call within 15 min                  |
| SEV-2 | Targeted compromise of one or two accounts; partial outage       | One teacher's account taken over; one webhook source 503ing                                   | Acknowledge within 1 hour                   |
| SEV-3 | Suspicious activity, no confirmed impact                         | Spike in failed sign-ins for one email; oddly-shaped Sentry event                             | Triage within one business day              |

Crown jewels:
`BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `INNGEST_SIGNING_KEY`,
`RESEND_API_KEY`, `DATABASE_URL` password, `SESSION_SECRET`. Any of these
landing in a public surface is an automatic SEV-0. (`META_ACCESS_TOKEN` /
`META_WEBHOOK_VERIFY_TOKEN` were on this list until the whole WhatsApp
Cloud API messaging integration was removed 2026-07-05, D-42 — those
secrets no longer exist. See §4.8 for `BETTER_AUTH_SECRET` rotation.)

---

## 2. Roles

| Role               | Default holder                    | Responsibilities                                              |
| ------------------ | --------------------------------- | ------------------------------------------------------------- |
| Incident commander | Platform lead                     | Drives the timeline; declares SEV; decides when to stand down |
| Tech lead          | Whoever knows the affected system | Hands-on remediation                                          |
| Comms lead         | Founder                           | External messaging (teachers / students / regulator)          |
| Scribe             | Whoever picks up the thread       | Maintains the timeline doc — every action, every decision     |

For SEV-2 / SEV-3 one person can hold multiple roles. For SEV-0 / SEV-1
the IC must be distinct from the tech lead — one steers, one fixes.

---

## 3. The phases

### 3.1 Detect

Sources of signal, in roughly decreasing order of speed:

- PagerDuty page (when added — currently routes via Sentry only).
- Sentry "issues" tab — `surface:` tag filters scope quickly.
- Customer report by email or in-product feedback.
- Stripe dashboard notification.
- GitHub secret-scanning alert.
- A regulator inquiry. (If this is the first source of signal, you are
  already behind — declare SEV-1 or higher and contact counsel.)

### 3.2 Triage

1. Open a private Slack channel: `#inc-YYYYMMDD-{slug}`. Pin a short
   description, the suspected SEV, and the IC's name.
2. Start the timeline doc (Notion / Google Doc, your choice). Every
   row: `HH:MM UTC — actor — action`.
3. Confirm scope:
   - Which secret / table / endpoint is implicated?
   - When did the suspicious activity start? (use Sentry / SQL
     against the DB: see queries in §6 below)
   - Is it still happening?
4. Declare SEV. If unsure, round up — downgrading later costs nothing.

### 3.3 Contain

The goal here is to stop the bleed, not to be tidy. Speed matters.

- If a secret is confirmed exposed: rotate it _now_ (§4 below) before
  investigating further. The rotation playbook covers every secret.
- If an account is confirmed compromised: disable it via `/admin`
  (`disable_teacher` / `disable_student` action recorded in `Override`).
- If a webhook endpoint is being abused: pause via the Stripe dashboard.
  Do not delete it; pausing is reversible.
- If an attack surface is broader (e.g. all sign-ups are being
  abused): consider temporarily setting a tighter rate-limit window in
  `lib/rate-limit.ts` and shipping a hotfix, or putting the route
  behind a maintenance page.

If the production database is suspected compromised, do not delete
data. Snapshot first (a Neon branch/snapshot from the console, or
`pg_dump` against the Neon production connection) so the forensic
record survives the fix.

### 3.4 Eradicate

- Deploy the fix on a hotfix branch named `hotfix/inc-YYYYMMDD-{slug}`.
  Skip CI gating only if the alternative is a longer outage; document
  the override in the timeline.
- Re-verify that the surface that was abused no longer accepts the
  abuse case. If unsure, replay the original signal — do not declare
  eradication on theory alone.

### 3.5 Recover

- Re-enable any paused surfaces (webhooks, accounts).
- Monitor for 72 hours: Sentry filter on the relevant `surface` tag,
  Neon / app logs filtered to the affected table.
- Communicate with affected users (see §5 notification obligations).

### 3.6 Post-mortem

Within 5 business days, write a post-mortem with:

- **Timeline** — copy from the scribe's doc, sanitized.
- **Root cause** — what the actual bug or misconfiguration was.
- **Contributing factors** — what made the bug land, or made it harder
  to detect / contain.
- **What went well, what we'll do differently** — be specific. "Better
  monitoring" is not actionable; "Add an alert when Stripe webhook
  signature failures exceed N/min" is.
- **Follow-up actions** — file as issues in the repo, link from the
  post-mortem.

Post-mortems are blameless. The aim is the system, not the person.

---

## 4. Secret rotation playbook

Rotate _before_ you investigate when a secret exposure is plausible.
A rotation that turns out to be unnecessary costs minutes; a missed
rotation costs the entire blast radius.

### 4.1 `SUPABASE_SERVICE_ROLE_KEY`

Removed — the Supabase service-role key no longer exists post-D-89
(production migrated off Supabase onto Neon; there is no Supabase project).

### 4.2 `STRIPE_SECRET_KEY`

1. Stripe dashboard → Developers → API keys → roll the live secret key.
2. Update the Fly secret (`fly secrets set STRIPE_SECRET_KEY=… -a agendaprofe`).
3. It hot-applies on machine restart.
4. Revoke the old key from the Stripe dashboard.

Downstream impact: in-flight Checkout sessions complete on the new key
because Stripe re-fetches via the platform credentials. Refunds in
progress may need to be retried.

### 4.3 `STRIPE_WEBHOOK_SECRET`

1. Stripe dashboard → Developers → Webhooks → the endpoint → "Reveal
   signing secret" → "Roll secret".
2. Stripe shows the old and new secrets for a 24h overlap window.
3. Update the Fly secret to the new value
   (`fly secrets set STRIPE_WEBHOOK_SECRET=… -a agendaprofe`).
4. Within 24h Stripe stops accepting the old one — done.

Downstream impact: zero if rotated within Stripe's overlap window.

### 4.4 `INNGEST_SIGNING_KEY` / `INNGEST_EVENT_KEY`

1. Inngest dashboard → Production environment → Settings → roll keys.
2. Update the Fly secret(s)
   (`fly secrets set INNGEST_SIGNING_KEY=… INNGEST_EVENT_KEY=… -a agendaprofe`).
3. Inngest holds in-flight events; they replay on the new key.

### 4.5 `RESEND_API_KEY`

1. Resend dashboard → API Keys → revoke + create.
2. Update the Fly secret (`fly secrets set RESEND_API_KEY=… -a agendaprofe`).
3. Outbound transactional emails resume within seconds.

### 4.6 `SESSION_SECRET`

1. Generate via `openssl rand -base64 32`.
2. Update the Fly secret (`fly secrets set SESSION_SECRET=… -a agendaprofe`).
3. **All sessions are invalidated.** Teachers and students will need to
   sign in again. Coordinate with comms before rotating unless it is
   an active SEV-0/1.

### 4.7 `DATABASE_URL` / `DIRECT_URL` password

1. Neon dashboard → the production project → Roles → reset the role's
   password.
2. The dashboard shows the new connection strings; update the Fly secrets
   (`fly secrets set DATABASE_URL=… DIRECT_URL=… -a agendaprofe`) _and_
   GitHub Actions secrets.
3. Fly restarts the machines to apply. Brief downtime during the reset — the
   app cannot connect while the password is mid-rotation. Expect 30–60 seconds
   of 5xx.

### 4.8 `BETTER_AUTH_SECRET`

1. Generate via `openssl rand -base64 32`.
2. Update the Fly secret (`fly secrets set BETTER_AUTH_SECRET=… -a agendaprofe`);
   the machine restart applies it.
3. **All sessions are invalidated** — better-auth signs/verifies session
   tokens with this secret, so every teacher and student is signed out and
   must sign in again (same blast radius as §4.6's `SESSION_SECRET`, and for
   the same reason: it's a token-signing key, not a per-record credential).
   Coordinate with comms before rotating unless it's an active SEV-0/1.
4. Confirm with a fresh sign-in (the web magic link) post-rotation
   before standing down — a bad value here fails closed (nobody can sign in),
   not open.

---

## 5. Notification obligations

⚠️ **Who must be told, on what clock, is not recorded in this repository** — see
[D-159](../decisions/D-159.md). Establish it before an incident, not during one.

What this runbook does say: keep the contact address on `/privacy-notice` routed
to a human who can pick up urgent mail, and when notifying anyone, state plainly
what happened, what data was affected, what is being done about it, and what the
recipient should do.

### 5.3 Stripe (payment-related)

Notify Stripe within 24 hours via the Connect dashboard or
`disputes@stripe.com`. Stripe's terms require prompt notice of any
event affecting cardholder data — even though our PCI scope is SAQ A
and we don't touch PANs, the contractual obligation persists.

### 5.4 Internal

Within 24 hours: a Slack message to `#general` (sanitized — no PII,
no secrets) summarizing the incident and any user-facing impact.

---

## 6. Useful queries

The DB queries below assume you have `DIRECT_URL` set locally and are
connected with `psql`.

### 6.1 Recent sign-ins for one email

`auth.users` was Supabase Auth's schema and no longer exists — auth is
better-auth on plain Postgres via Prisma (D-40), fully decommissioned from
Supabase per D-89 (§4.1 above already reflects this). better-auth's own
tables are `user` and `session` (`@@map("user")` / `@@map("session")` in
`apps/web/prisma/schema.prisma`); there is no `email_confirmed_at` /
`last_sign_in_at` / `raw_user_meta_data` equivalent — `user."emailVerified"`
is the closest to the first, and each `session` row (one per sign-in) is
the closest to the second. better-auth does not persist _failed_ sign-in
attempts to the DB (those are only visible via the in-memory/Upstash rate
limiter or Sentry), so this only surfaces successful sign-ins:

```sql
SELECT u.email, u."emailVerified", u."createdAt" AS account_created_at,
       s."createdAt" AS session_created_at, s."ipAddress", s."userAgent"
FROM "user" u
JOIN "session" s ON s."userId" = u.id
WHERE u.email = '...'
ORDER BY s."createdAt" DESC
LIMIT 5;
```

### 6.2 All admin actions in a window

```sql
SELECT created_at, teacher_id, target_type, target_id, action, reason
FROM overrides
WHERE created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

### 6.3 Payments touched recently

```sql
SELECT id, status, provider, amount_minor_units, paid_at, refunded_at, updated_at
FROM payments
WHERE updated_at >= now() - interval '6 hours'
ORDER BY updated_at DESC
LIMIT 50;
```

### 6.4 Webhook events stored locally (after §11.10)

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

## 7. Contact list

Filled in by ops, not committed here. The recommended pattern is a
sealed envelope in 1Password ("Incident Contacts") with:

- Each team member's phone, personal email, alternate Slack handle.
- The Neon and Fly support contacts.
- The Stripe Connect contact.
- Legal contact, for breach-notification guidance.

Do not commit phone numbers or alternate emails to the repo.

---

## 8. After-incident: update the plan

The post-mortem feeds back into [`../security.md`](../security.md). If the incident
exposes a control we didn't have or a gap we didn't anticipate, add
the fix as a numbered roadmap item with the same priority/effort/files
shape as the existing entries. The next quarterly review checks that
these new items moved forward.
