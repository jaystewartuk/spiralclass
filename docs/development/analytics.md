# Analytics (PostHog)

PostHog is the product analytics, session replay, feature flags, experiments,
surveys and web-vitals platform. **Error tracking is Sentry's job, not
PostHog's** — don't add `captureException` calls here.

## Architecture at a glance

- **Server-side capture is primary** (`apps/web/src/lib/analytics/posthog.ts`,
  `posthog-node`). It survives ad-blockers and fires the business-critical
  events (signups, payments, bookings). Events are a **typed union** — you
  cannot fire an event the type does not know about.
- **Client-side SDK** (`apps/web/src/lib/analytics/posthog-browser.ts`,
  `posthog-js`) is mounted app-wide via `PostHogProvider`
  (`src/components/posthog-provider.tsx`) in the root layout. It adds
  autocapture, session replay, feature-flag hooks, surveys and web vitals, and
  reaches the **same Person** as the server via `identify` (keyed by user id).
- **Reverse proxy:** the browser ingests through `/ingest`, which
  `next.config.ts` rewrites to the regional PostHog hosts, so ad-blockers don't
  drop client events by hostname.
- **Everything is null-safe.** With no key, an ad-blocker, or `NODE_ENV=test`,
  every helper no-ops and every hook falls back — nothing crashes.

## Environment variables

| Var                          | Side   | Purpose                                                                                                                  |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `POSTHOG_KEY`                | server | Project API key (`phc_*`) for `posthog-node`. Required in production (`assertProductionCredentials`).                    |
| `POSTHOG_HOST`               | server | Server ingestion host. Blank derives it from the region. Required in production.                                         |
| `POSTHOG_PERSONAL_API_KEY`   | server | Optional (`phx_*`). Enables **local** feature-flag evaluation (no per-check network hop).                                |
| `POSTHOG_PROJECT_ID`         | server | Optional. The numeric project id the `/admin/uat` PostHog check queries; absent, that check reports itself unconfigured. |
| `NEXT_PUBLIC_POSTHOG_KEY`    | client | Same project key, exposed to the browser. Missing → the client SDK never initializes.                                    |
| `NEXT_PUBLIC_POSTHOG_HOST`   | client | Optional. Overrides the `/ingest` proxy (debugging only).                                                                |
| `NEXT_PUBLIC_POSTHOG_REGION` | both   | `us` (default) or `eu`. Aims the proxy destinations and the SDK's `ui_host` at that region's hosts.                      |

The region is resolved in one place, `src/lib/analytics/posthog-region.ts`. The
PostHog project itself is pinned to one region in the PostHog dashboard, so
changing region means recreating the project there and then setting
`NEXT_PUBLIC_POSTHOG_REGION`.

## Adding a new event

Events live in **one place**: the `ServerEvent` union in
`src/lib/analytics/posthog.ts`. To add one:

1. Add a variant to the `ServerEvent` union with a `name`, `distinctId`, and
   typed `properties`.
2. Call it from the server action, route or Inngest function:

   ```ts
   import { trackServerEvent } from "@/lib/analytics/posthog";

   trackServerEvent({
     name: "booking_created",
     distinctId: student.id,
     properties: { teacherId, bookingId, packageId, via: "via_link" },
   });
   ```

3. **Every** `trackServerEvent` call site needs `await flushAnalytics()`
   downstream before its handler returns — a server action, route, webhook, or
   Inngest function step, not just long-running ones. posthog-node sends on its
   own background timer, and Cloud Run idles and cold-starts instances, so an
   unflushed event is silently lost. Route handlers wrapped in `handle()`
   (`src/lib/api/route.ts`) get this for free; everything else calls it
   directly, right before the redirect or return.

Client-side one-offs (e.g. an experiment goal metric) use the hook:

```ts
const posthog = usePostHog();
posthog?.capture("example_feature_cta_clicked", { variant });
```

### Naming convention

`object_verb`, lowercase `snake_case`, past tense: `teacher_signup_completed`,
`booking_created`, `payment_received`, `reschedule_completed`. Put identifiers
and dimensions in `properties`, never in the event name.

### Client and server event pairs

A few funnel steps fire from **both** the client SDK and the server pipeline,
under **different names**, because they measure different moments:

- `checkout_submitted` (client, `src/app/b/[slug]/buy/checkout-form.tsx`) fires
  the instant the buy form submits — JS ran, validation passed — while
  `checkout_started` (server, `src/lib/payments/start-checkout.ts`) fires once
  the Payment row exists. The gap between them separates client-side abandons
  from server-side drop-offs.
- `teacher_signed_in` / `teacher_signup_completed` fire from the better-auth
  `session.create.after` hook and lazy Teacher provisioning, so one server-side
  place covers every way a session can be created.

**Never give a client event and a server event the same name** when they
measure different moments of the same action: every occurrence double-counts
under one name, with no property to split by.

## Identifying users

Handled automatically:

- **Server:** `identifyServerUser` runs from the auth gates (`@/lib/auth`,
  `@/lib/api/auth`, `@/lib/admin`), idempotent per process.
- **Client:** `<PostHogIdentify>` in the authenticated layouts (`(app)`,
  `(student)`, `admin`) calls `posthog.identify` with the same `distinctId`,
  and `posthog.group("teacher", id)` for per-teacher group analytics.
- **Logout:** `<SignOutButton>` calls `posthog.reset()` so the next anonymous
  visitor on the device doesn't inherit the account.

> [!IMPORTANT]
> Keep `distinctId` equal to the row id the server uses (`teacher.id` /
> `student.id` / admin actor id) or one user splits across two Persons.

## Feature flags

Create the flag in the PostHog dashboard, then read it.

**Client** (React hook, with a safe fallback):

```tsx
import { useFeatureFlagEnabled } from "posthog-js/react";
const enabled = useFeatureFlagEnabled("example-new-feature") ?? false;
```

**Server** (Server Component, action or route):

```ts
import { isServerFeatureEnabled } from "@/lib/analytics/posthog";
const enabled = await isServerFeatureEnabled("example-new-feature", teacher.id, false);
```

Both return the fallback when PostHog is unavailable. A dark-launch switch that
needs no PostHog round trip is an environment flag instead — see
[workflow.md](workflow.md#feature-flags).

## Experiments (A/B tests)

An experiment is a **multivariate flag** plus a goal metric, configured in the
PostHog UI. In code you read the variant and capture the goal event:

```tsx
const variant = useFeatureFlagVariantKey("example-dashboard-cta") ?? "control";
// ...render per variant...
posthog?.capture("example_feature_cta_clicked", { variant });
```

Server-side variant reads use `getServerFeatureFlag(key, distinctId, "control")`.

## Session replay

On app-wide (`posthog-browser.ts`). Privacy:

- `maskAllInputs: true` masks every form input by default.
- Network capture records **headers only, not bodies** — this is a payments
  app, and bodies can carry personal data, tokens or Stripe payloads.
- Console logs are captured to make replays useful for debugging.
- To mask an extra element, give it `class="ph-no-capture"`.

## Surveys

Enabled in the SDK config. Popover surveys are created and targeted entirely in
the PostHog dashboard and render automatically — no app code.
