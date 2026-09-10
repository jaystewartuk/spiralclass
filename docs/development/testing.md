# Testing

What the test suite is made of, what each layer is for, and how to run any of
it. The definition of "green" lives in one place — `scripts/ci/steps.mjs` — and
[the workflow](workflow.md) describes when each tier runs. This document is
about the tests themselves.

## The commands

```bash
pnpm test                    # unit — no database, seconds
pnpm test:integration:local  # integration — boots its own Postgres on :5433
pnpm test:e2e                # Playwright, hermetic
pnpm gate --allow-dirty      # everything the pre-push hook will check
pnpm gate:full               # the above plus mutation, integration and browsers
```

Single files, per workspace (Turborepo's tasks do not take file arguments, so
target a workspace and forward args after `--`):

```bash
pnpm --filter spiralclass-web test -- src/lib/money.test.ts
pnpm --filter spiralclass-web test:watch -- src/lib/money.test.ts
pnpm --filter @spiralclass/shared test -- src/money.test.ts
```

## The layers

There are 785 test files. They are not all the same kind of thing.

| Layer                 | Runs                                           | Needs                         | Where                                     |
| --------------------- | ---------------------------------------------- | ----------------------------- | ----------------------------------------- |
| **Unit**              | every push, in the fast tier                   | nothing                       | beside the module, or `apps/web/tests/`   |
| **Integration**       | every PR and every push to `main`, on a runner | Docker + a real Postgres      | `*.integration.test.ts`                   |
| **End-to-end**        | same                                           | Docker + a production build   | `apps/web/tests/e2e/`                     |
| **Visual regression** | same                                           | Chromium, committed baselines | `apps/web/tests/visual/`                  |
| **Accessibility**     | same                                           | Chromium                      | `playwright.a11y.config.ts`               |
| **Mutation**          | same                                           | nothing                       | `apps/web/scripts/mutation-spotcheck.mjs` |

**Unit** is Vitest, colocated with the module it covers. This is where most of
the suite lives and it is the only layer fast enough to run while writing code.

**Integration** is 23 suites against a real Postgres — `postgres:16` in
Docker — plus a production `next build` that validates the route manifest and a migration-drift
check. It exists for the things an in-memory fake cannot assert: `EXCLUDE`
constraints, partial unique indexes, transaction poisoning, Prisma error codes.

**End-to-end** is Playwright against a real production build, hermetic — a fresh
Postgres, seeded fixtures, and an in-memory Stripe stub. No secrets, no network,
no Stripe account. See [below](#end-to-end-in-detail).

**Visual regression** captures every route in `apps/web/tests/visual/routes.ts`
at six viewports in both themes. Playwright names a snapshot after the platform
that took it, and there is one set — `-linux.png`, asserted on `ubuntu-latest`
and nowhere else ([D-171](../decisions/D-171.md)). The suite **skips** on a Mac
and says so, `scripts/ci/e2e.sh` refuses to regenerate there, and a page whose
look changes is re-baselined by dispatch:

```bash
gh workflow run heavy.yml -f update_visual_baselines=<route> --ref <branch>
```

To see how a page renders on your own machine, run `capture.spec.ts` — it writes
a gallery instead of asserting against one, so it needs no committed image.

**Mutation** is a spot-check, not a full run: it perturbs code and asserts the
suite notices, so the unit tests are measured on whether they would actually
catch a defect rather than on how many lines they touch.

## Coverage

Coverage is measured on `src/lib/**`, `src/app/actions/**` and `src/app/api/**`
only. Views are Playwright's job, and counting them would let a component's
render path inflate a number that is supposed to describe business logic.

Two floors, and they work differently:

- **An aggregate floor** in `apps/web/vitest.config.ts` that ratchets upward and
  never down.
- **A per-PR diff floor** on new code (`apps/web/scripts/diff-coverage.mjs`), so
  a large well-covered codebase cannot absorb an uncovered addition.

```bash
pnpm --filter spiralclass-web test:coverage
```

## Guard tests

A recurring pattern here, and the ones worth reading. A guard test fails if a
_mechanism_ is dismantled, rather than if a function returns the wrong number.

- `tests/config/local-gate.test.ts` fails if `open-pr.sh` grows a merge, a
  deploy or a gate bypass; if a workflow restates a check the registry already
  defines; if a runner is not `ubuntu-latest`; if an action is not SHA-pinned;
  if a workflow is missing `permissions`, `timeout-minutes` or `concurrency`.
  Its forbidden-command list is **derived from `scripts/ci/steps.mjs`**, so a
  check added there is covered the moment it lands rather than when somebody
  remembers to widen a list.
- `tests/config/doc-paths.test.ts` fails if any `docs/…` path written anywhere
  in the repository names a file that does not exist. Its exception list is a
  ratchet that can only shrink.
- `tests/config/doc-links.test.ts` fails if a relative link in any Markdown file
  does not resolve. It has no exception list — a dead link has one honest fix.
- `packages/shared/src/marketing/*.test.ts` fail if the platform-safety gate on
  promotional content loosens.
- `packages/shared/src/i18n/i18n.test.ts` fails if a public marketing string
  narrows the audience back to language teaching, and if the fee-disclosure keys
  go missing from a locale.
- `scripts/readme-counts.mjs` recounts every number stated in the README and the
  architecture docs from the tree, and fails if a sentence has drifted.

**Guard tests have a failure mode of their own**: a guard outlives the premise
it was written for, keeps passing, and quietly protects something nobody needs
any more. One here held 220 unreachable routes in place for a month after the
client that called them was deleted. When you retire a thing, retire its guard in the same
change.

## End-to-end, in detail

The suite lives in `apps/web/tests/e2e/` and is driven by `scripts/ci/e2e.sh`.
`happy-path.spec.ts` is the critical path: seeded teacher → student booking page
→ purchase through the Stripe stub → email-OTP sign-in → reserve a slot →
confirmation.

```bash
pnpm test:e2e                    # happy-path.spec.ts only
E2E_EXTENDED=1 pnpm test:e2e     # every journey — what the gate runs
E2E_EXTENDED=1 pnpm exec playwright test tests/e2e/refund.spec.ts
```

Set `E2E_RATE_LIMIT_BYPASS=1` locally if you add a spec with several sign-ins:
the whole suite hits one server process with one in-memory rate-limit bucket.
⚠️ `pnpm dev` holds port 3000, which the browser suites need — stop it first.

**It stands the whole stack up from scratch on each run**, which is why it needs
no secrets and no environment:

1. A plain `postgres:16` container.
2. `prisma migrate deploy` against it.
3. The seed (`apps/web/scripts/seed.ts`) — each seeded person is provisioned
   directly with a generated UUID and a `user`-table row, matching how
   better-auth's own tables work. Fixture material uploads go through the app's
   real storage provider and fail gracefully with no R2 credentials; the rows
   still get created and nothing asserts on the uploaded bytes.
4. A **production** build (`next build` + `next start`, never `next dev`) — the
   durable fix for a long tail of flakiness that `next dev`'s on-demand route
   compilation caused on a loaded runner. The Stripe stub is opted into that
   build with `E2E_STRIPE_STUB=1`, which is never set in a real deploy and fails
   closed there.
5. Playwright against the prebuilt server.

Every run gets a fresh deterministic stack: no shared-state drift,
parallel-safe, and nothing to keep secret.

### Fixtures

Seeded accounts live in `apps/web/scripts/seed.ts` and come in two kinds.

- **Shared and read-only** — the E2E-critical teacher and the hero matrix. Read
  them, assert on them, never mutate them. Their emails, slugs, Stripe flags,
  template names and availability are pinned by the seed file's own header.
- **Dedicated and spec-owned** — one per journey that needs to mutate a teacher
  (the Wise checkout journeys, the rail-connect journey). A spec that mutates a
  teacher must own a fixture outright and restore it in `afterAll`. Mutating a
  shared hero leaks across spec files and makes the suite order-dependent.

Specs that create students collect their addresses and delete them in
`afterAll`.

Helpers are imported from the `_helpers` barrel, never from a file directly, and
**must never import `@/lib/*`** — Playwright's CJS loader cannot load the app's
ESM wrappers.

### What it deliberately does not cover

- **The real deployed artifact** — runtime, config, CDN. That is the production
  probes' job (`pnpm local synthetic`, and the last step of every production
  deploy). Keeping the two separate lets the pre-merge suite stay hermetic
  instead of depending on a live deployment.
- **Subscription upgrade.** Mostly a non-gap: the substance (webhook →
  lifecycle → `entitlementsFor()`) is covered against a real database by
  `tests/subscriptions/billing-webhook.integration.test.ts`, and the entry point
  by unit tests. It cannot move here — the handler re-fetches canonical state
  through the Stripe client and the stub's subscription map lives inside the
  `next start` process, so an out-of-process replay throws.
- **The video call**, which needs two live participants and a media stack.
- **Voice and video messages**, which need a real `MediaRecorder` capture and a
  storage stub.
- **Inngest jobs and PostHog analytics** — neither runs in the hermetic gate.
  This is also why no spec asserts a notification's `status`: rows stay `queued`
  here, and pinning that would encode "Inngest is absent" as an expectation.

Those gaps are hand-checked against the `/admin/uat` runbook before a promote.

## The rule

**A change is not done until it ships with tests** covering the new behaviour,
and the regression if it is a fix. There is one client, so that means web tests.
