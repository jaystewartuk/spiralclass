# Analytics (PostHog)

PostHog is our product analytics, session replay, feature flags,
experiments, surveys, and web-vitals platform. **Error tracking is
Sentry's job, not PostHog's** — don't add `captureException` calls here.

## Architecture at a glance

- **Server-side capture is primary** (`src/lib/analytics/posthog.ts`,
  `posthog-node`). It survives ad-blockers (§13.9) and fires the
  business-critical events (signups, payments, bookings). Events are a
  **typed union** — you can't fire an event the type doesn't know about.
- **Client-side SDK** (`src/lib/analytics/posthog-browser.ts`,
  `posthog-js`) is mounted app-wide via `PostHogProvider` in the root
  layout. It adds autocapture, session replay, feature-flag hooks,
  surveys, and web vitals, and reaches the **same Person** as the server
  via `identify` (keyed by user id).
- **Reverse proxy:** the browser ingests through `/ingest`
  (`next.config.ts` rewrites → US cloud) so ad-blockers don't drop client
  events by hostname.
- **Everything is null-safe.** With no key / ad-blocked / `NODE_ENV=test`,
  every helper no-ops (server logs to stderr) and every hook falls back —
  nothing crashes.

## Environment variables

| Var                        | Side   | Purpose                                                                                   |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `POSTHOG_KEY`              | server | Project API key (`phc_*`) for `posthog-node`.                                             |
| `POSTHOG_HOST`             | server | Ingestion host. Default `https://us.i.posthog.com` (US cloud). Required in production.    |
| `POSTHOG_PERSONAL_API_KEY` | server | Optional (`phx_*`). Enables **local** feature-flag evaluation (no per-check network hop). |
| `NEXT_PUBLIC_POSTHOG_KEY`  | client | Same project key, exposed to the browser. Missing → client SDK never initializes.         |
| `NEXT_PUBLIC_POSTHOG_HOST` | client | Optional. Overrides the `/ingest` proxy (debugging only).                                 |

US vs EU: we're on **US cloud** (closest to MX users, decision
2026-06-03). To move to EU, swap the hosts in `.env`, change the proxy
destinations in `next.config.ts` (`us.i`/`us-assets.i` → `eu.i`/`eu-assets.i`),
and set `ui_host` to `https://eu.posthog.com` in `posthog-provider.tsx`.

## Adding a new event

Events live in **one place**: the `ServerEvent` union in
`src/lib/analytics/posthog.ts`. To add one:

1. Add a variant to the `ServerEvent` union with a `name`, `distinctId`,
   and typed `properties`.
2. Call it from the server action / route / Inngest function:

   ```ts
   import { trackServerEvent } from "@/lib/analytics/posthog";

   trackServerEvent({
     name: "booking_created",
     distinctId: student.id,
     properties: {
       teacherId,
       teacherName,
       bookingId,
       packageId,
       classId, // PackageTemplate id — null on legacy/manual packages
       className, // PackageTemplate.name, null if no template
       classType: "single_class" | "package",
       scheduledAt, // ISO timestamp of the booked slot
       via: "via_link",
     },
   });
   ```

3. **Every** `trackServerEvent` call site needs `await flushAnalytics()`
   somewhere downstream before its handler returns — a server action,
   route, webhook, or Inngest function/cron step, not just "long-running"
   ones. `flushAt: 1` / `flushInterval: 0` mean the actual HTTP POST to
   PostHog still happens on posthog-node's own background timer; without an
   explicit flush, it depends on incidental process longevity (fine on
   today's Fly.io persistent container, silently lossy on a more
   aggressively recycled runtime). Route handlers wrapped in `handle()`
   (`lib/api/route.ts`) get this for free — everything else calls it directly,
   right after (or instead of immediately before) the redirect/return.

Client-side one-offs (e.g. an experiment goal metric) use the hook:

```ts
const posthog = usePostHog();
posthog?.capture("example_feature_cta_clicked", { variant });
```

### Naming convention

`object_verb`, lowercase `snake_case`, past tense:
`teacher_signup_completed`, `booking_created`, `payment_received`,
`reschedule_completed`. Put identifiers and dimensions in `properties`,
never in the event name.

### Client + server event pairs (deliberate, not duplicates)

A few funnel steps deliberately fire from **both** the client SDK
(`posthog-js`) and the server `ServerEvent` pipeline, under **different
names**, because they measure different things:

- `checkout_submitted` (client) fires the instant the buy form submits — JS
  ran, validation passed — vs. `checkout_started` (server,
  `lib/payments/start-checkout.ts`), which fires once the Payment row actually
  exists. A gap between the two isolates client-side abandons from server-side
  drop-offs.
- `teacher_signed_in` / `teacher_signup_completed` fire from the better-auth
  `session.create.after` hook and lazy Teacher provisioning, so one server-side
  place covers every way a session can be created.

**Never give a client event and a server event the SAME name** if they measure
different moments of the same action — that silently double-counts every event
under one name with no property to split by. That bug shipped once: two
checkout entry points both used `checkout_started` until one was renamed to
`checkout_submitted`.

## Identifying users

Handled automatically:

- **Server:** `identifyServerUser` runs from the auth boundary
  (`requireTeacher` / `requireStudent` / `requireAdmin`), idempotent
  per process.
- **Client:** `<PostHogIdentify>` in the authenticated layouts
  (`(app)`, `(student)`, `admin`) calls `posthog.identify` with the same
  `distinctId`, and `posthog.group("teacher", id)` for per-teacher group
  analytics.
- **Logout:** `<SignOutButton>` calls `posthog.reset()` so the next
  anonymous visitor on the device doesn't inherit the account.

> Keep `distinctId` equal to the row id the server uses (`teacher.id` /
> `student.id` / admin actor id) or you'll split one user across two
> Persons.

## Feature flags

Create the flag in the PostHog dashboard, then read it.

**Client** (React hook, with a safe fallback):

```tsx
import { useFeatureFlagEnabled } from "posthog-js/react";
const enabled = useFeatureFlagEnabled("example-new-feature") ?? false;
```

**Server** (Server Component / action / route):

```ts
import { isServerFeatureEnabled } from "@/lib/analytics/posthog";
const enabled = await isServerFeatureEnabled("example-new-feature", teacher.id, false);
```

Both default to the fallback when PostHog is unavailable. See
`src/components/example-new-feature.tsx` for a worked example.

## Experiments (A/B tests)

An experiment is a **multivariate flag** plus a goal metric, configured in
the PostHog UI. In code you (1) read the variant and (2) capture the goal
event:

```tsx
const variant = useFeatureFlagVariantKey("example-dashboard-cta") ?? "control";
// ...render per variant...
posthog?.capture("example_feature_cta_clicked", { variant });
```

Server-side variant reads use `getServerFeatureFlag(key, distinctId, "control")`.

## Session replay

On app-wide (`posthog-provider.tsx`). Privacy:

- `maskAllInputs: true` masks every form input by default.
- Network capture records **headers only, not bodies** (this is a
  payments app — bodies can carry PII / tokens / Stripe payloads).
- Console logs are captured to make replays useful for debugging.
- To mask an extra element, give it `class="ph-no-capture"`.

## Surveys

Enabled in the SDK config. Popover surveys are created and targeted
entirely in the PostHog dashboard and render automatically — no app code.
