# Reading production

Where a session reads what production is doing: errors, usage and logs. Read
the live system before naming a cause. A cause inferred from code is a
hypothesis, and the report should say which of the two it is.

| Question                         | Where                        | Filter that matters                         |
| -------------------------------- | ---------------------------- | ------------------------------------------- |
| What is failing, and since when? | Sentry                       | `environment:production`, then `surface`    |
| Is anyone real using it?         | PostHog                      | person property `is_test_account` not true  |
| What did the server log?         | Cloud Logging, service `web` | `jsonPayload.level`, `jsonPayload.surface`  |
| Does every public page answer?   | `pnpm local synthetic`       | none; it probes production's public surface |
| What is in the database?         | Operator only (`psql`)       | the queries in INCIDENT_RESPONSE §6         |

The repository is public, so this page names tools and filters, never project,
organisation or account identifiers. Ask the operator for those.

## How a session gets access

- **Sentry and PostHog** are read through their MCP connectors when the operator
  has connected them to the session. PostHog's organisation can hold more than
  one project, so check which project is active before you trust a number. With
  no connector, say so and ask; do not estimate.
- **Cloud Logging** is read with `gcloud`. Reading (`logging read`, `describe`,
  `list`) is allowed in a session; writing is denied (CLAUDE.md). If the
  credentials have expired, `gcloud` says `invalid_grant`. Report that, because
  re-authenticating is the operator's step.
- **The production database** is the operator's. Its credential is not in a
  session's environment, and nothing here should put it there.

## Errors: Sentry

Error tracking is Sentry's job, not PostHog's ([analytics.md](analytics.md)).

- Filter on **`environment:production`**. The value comes from `APP_URL` on the
  server and from the hostname in the browser
  (`apps/web/src/lib/sentry-environment.ts`), so local and preview errors do not
  mix in.
- Then narrow by **`surface`**. Every `logger({ surface })` call in
  `apps/web/src/lib/logger.ts` sends its base fields to Sentry as tags, so
  `surface:stripe-webhook` gives one subsystem's errors.
- Known noise is dropped before it is sent (`apps/web/src/lib/sentry-noise-filters.ts`).
  An error you expected and cannot find may have been filtered there.

## Usage: PostHog

> [!WARNING]
> Without a test-account filter, the operator's own test traffic reads as real
> teachers and students. Add the filter to every usage figure.

- Filter on the person property **`is_test_account`**. The server sets it when
  it identifies a user (`apps/web/src/lib/analytics/posthog.ts`) and the browser
  sets it on every signed-in page (`apps/web/src/components/posthog-identify.tsx`).
- Filter it as **is not `true`**, never as equal to `false`. Most persons never
  signed in (anonymous visitors to the public funnel) and have no value, and
  `= false` drops them all. In SQL:

  ```sql
  coalesce(toString(person.properties.is_test_account), '') != 'true'
  ```

- **Do not rely on PostHog's own "filter out internal and test users" switch.**
  It is configured in the PostHog project, not in this repository. Nothing here
  checks what it matches, and it does not have to key on `is_test_account`.
  Add the property filter yourself, even with the switch on.
- Events recorded before an account was marked are not rewritten, so a count
  over older events can still include its traffic. Check a surprising figure
  against the person list.
- Production reports `$web_vitals` too, so page speed is read here as well.

The database has its own definition of a test account, used by every figure the
admin console shows: `apps/web/src/lib/marketing/test-accounts.ts`. What it
covers and does not cover yet is in
[admin-portal.md](../features/admin-portal.md#test-accounts).

## Logs: Cloud Logging

Production runs on Cloud Run as the service `web` in `us-east4`. The app logs one
JSON object per line through `apps/web/src/lib/logger.ts`, and Cloud Logging
parses each line into `jsonPayload`:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="web"
   AND jsonPayload.level="error"' \
  --freshness=1h --limit=50 \
  --format='value(timestamp,jsonPayload.surface,jsonPayload.msg)'
```

- Filter on **`jsonPayload.level`**, not on `severity`. The logger writes no
  `severity` field, so Cloud Logging sets one from the stream: `console.warn` and
  `console.error` both arrive on stderr, so warnings show as errors there.
- Narrow with **`jsonPayload.surface="<surface>"`**, the same value Sentry tags.
  `jsonPayload.correlationId` follows one request or webhook event where the
  caller set it.
- Logs also show what Sentry does not: info lines, cold starts, and a process
  that stopped answering without throwing.

## After a deploy

[workflow.md](workflow.md#6-promote--it-happens-by-itself-and-you-approve-it) asks for about
fifteen minutes of watching after a deploy. That means: the probes passed (the
deploy runs them last), Sentry shows no new `environment:production` issue, and
the server log shows no new `jsonPayload.level="error"` surface.
