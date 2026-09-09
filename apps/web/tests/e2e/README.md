# Web E2E (Playwright)

Browser journeys against a real production build. What the suite covers, how it
is run and what it deliberately leaves uncovered is in
[`docs/development/testing.md`](../../../../docs/development/testing.md); this
file is the working reference for adding a spec.

```bash
pnpm test:e2e                    # happy-path.spec.ts only
E2E_EXTENDED=1 pnpm test:e2e     # every journey — what the gate runs
E2E_EXTENDED=1 pnpm exec playwright test tests/e2e/refund.spec.ts   # one spec
```

Set `E2E_RATE_LIMIT_BYPASS=1` locally if you add a spec with several sign-ins —
the whole suite hits one server process with one in-memory rate-limit bucket.
⚠️ Stop `pnpm dev` first; it holds port 3000.

The suite runs in `scripts/ci/e2e.sh`, which is a **heavy-tier step in
`scripts/ci/steps.mjs`**. That means it runs in `pnpm gate:full` on the laptop
and, since [D-161](../../../../docs/decisions/D-161.md), as one of the three
parallel jobs in `.github/workflows/heavy.yml` on every pull request and every
push to `main`. It is not a required check.

## Helpers (`_helpers/`)

Import from the barrel, never from a file directly.

| Helper                                            | Gives you                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `applyE2ESkipGuards({extended})`                  | The standard env / `E2E_EXTENDED` skip guards. Every spec calls this at top level.                                      |
| `signInAsViaOtp(page, email, next)`               | Browser sign-in as any seeded account, driving the real `/sign-in` form.                                                |
| `purchaseAndActivatePackage(page, context, opts)` | A student with an active package, via the real checkout funnel.                                                         |
| `bookAClass(page, context, opts)`                 | The above, on to a confirmed booking. `aheadDays` forces a ≥24h-out slot.                                               |
| `expectBothSidesNotified(bookingId, pattern)`     | Asserts a mutation enqueued notifications for student **and** teacher.                                                  |
| `deleteStudentsByEmail(emails)`                   | Teardown for specs that create students.                                                                                |
| `getPrisma()`                                     | A dedicated client. **Never import `@/lib/*` in a helper** — Playwright's CJS loader can't load the app's ESM wrappers. |

The bearer-session and JSON-header helpers went with a deleted API tree; there
is nothing left in this suite that talks to a route handler without a browser.

`happy-path.spec.ts` deliberately does **not** use the funnel helpers: it is the
one non-extended spec, and its inline copy interleaves assertions that are the
test rather than setup.

## Fixture rules

Seeded accounts live in `scripts/seed.ts`. Two kinds:

- **Shared, read-only** — the E2E-critical teacher and the hero matrix. Read
  them, assert on them, never mutate them. Their emails, slugs, Stripe flags,
  template names and availability are pinned by the seed file's own header.
- **Dedicated, spec-owned** — `wendy-wise` (Wise checkout journeys),
  `nora-norail` (the rail-connect journey). A spec that **mutates** a teacher
  must own a fixture like these outright, and restore it in `afterAll`.
  Mutating a shared hero leaks across spec files and makes the suite
  order-dependent.

Specs that create students push their addresses onto a `created` array and
delete them in `afterAll`.

Every persona name is invented and declared in `scripts/fixture-personas.json`,
which is what the leak check tests fixture names against.
