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
pnpm gate:full               # the above plus mutation, integration, browsers, image
```

Single files, per workspace (Turborepo's tasks do not take file arguments, so
target a workspace and forward args after `--`):

```bash
pnpm --filter spiralclass-web test -- tests/lib/money.test.ts
pnpm --filter spiralclass-web test:watch -- tests/lib/money.test.ts
pnpm --filter @spiralclass/shared test -- src/money.test.ts
```

## The layers

There are more than 800 test files. They are not all the same kind of thing.

| Layer                 | Runs                                                                  | Needs                                 | Where                                     |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| **Unit**              | every push, in the fast tier                                          | nothing                               | beside the module, or `apps/web/tests/`   |
| **Integration**       | every PR and every push to `main`, on a runner                        | Docker + a real Postgres              | `*.integration.test.ts`                   |
| **End-to-end**        | same                                                                  | Docker + a production build           | `apps/web/tests/e2e/`                     |
| **Visual regression** | same                                                                  | Chromium, committed baselines         | `apps/web/tests/visual/`                  |
| **Accessibility**     | same                                                                  | Chromium                              | `playwright.a11y.config.ts`               |
| **Mutation**          | same                                                                  | nothing                               | `apps/web/scripts/mutation-spotcheck.mjs` |
| **Production image**  | same                                                                  | Docker with buildx                    | `scripts/ci/image-build.sh`               |
| **Model evals**       | by hand, before and after a prompt or model change; never in the gate | an Anthropic key, or recorded outputs | `apps/web/evals/`, `pnpm evals`           |

**Unit** is Vitest, colocated with the module it covers. This is where most of
the suite lives and it is the only layer fast enough to run while writing code.

**Integration** is 27 suites against a real Postgres — `postgres:16` in
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

**Production image** builds the `Dockerfile` the production deploy builds —
`linux/amd64`, final stage, the same build args — with a stub for every
`__LOCAL__` key in `config/env/production.build.env`, and discards the result:
no push, no tag, no registry credential. Every other layer runs `next build` on
the runner's own Node, so before this step a broken base image or pnpm bootstrap
was first found by the production deploy, after it had migrated
(#100). On an arm64
laptop, `IMAGE_BUILD_PLATFORM=linux/arm64 bash scripts/ci/image-build.sh` is the
fast, weaker local answer; the amd64 verdict comes from the runner.

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
- **The video call**, which needs two live participants and a media stack —
  see it by hand instead ([below](#the-video-call-by-hand)).
- **Voice and video messages**, which need a real `MediaRecorder` capture and a
  storage stub.
- **Inngest jobs and PostHog analytics** — neither runs in the hermetic gate.
  This is also why no spec asserts a notification's `status`: rows stay `queued`
  here, and pinning that would encode "Inngest is absent" as an expectation.

Those gaps are hand-checked against the `/admin/uat` runbook before a promote.

## The video call, by hand

A change to the call screen is seen rendered, with a teacher and a student in
the same room, before its PR opens. One command sets that up:

```bash
pnpm call:local                           # Alicia teaches Carlos, class starting now
pnpm call:local --student maria@alumno.test
pnpm call:local --no-build                # reuse the last build
pnpm call:local code <email>              # after "Email me a code": the code is 424242
```

It brings up the dev database and a LiveKit dev server, moves the pair's next
class to now, builds, and serves on :3000. Open the teacher at
`http://localhost:3000` and the student at `http://preview.localhost:3000` —
two hosts, because cookies are per host and that is what keeps the two
sign-ins apart in one Chrome. Turn both cameras off before taking screenshots:
it is your webcam on both sides.

Every setting in it is there because the obvious thing failed:

| Obvious thing                                | What happens                                                                                                                                         | So the script…                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`, second user on another host      | `next dev` blocks its client scripts for any host but `localhost` ("Blocked cross-origin request to Next.js dev resource"); that page never hydrates | runs a production build (`next build` + `next start`)                     |
| `next start` with the local `APP_URL`        | a production build on a non-preview `APP_URL` demands production credentials; every request is a 500                                                 | sets `APP_URL=http://preview.localhost:3000`, as `scripts/ci/e2e.sh` does |
| the enforced CSP                             | `connect-src` has no `ws://localhost:7880`; the LiveKit socket is refused and the call says "Couldn't connect"                                       | sets `CSP_ENFORCE=0` (report-only)                                        |
| `livekit-server --dev` in Docker             | on a Mac it advertises the container's address for media: signalling works, ICE never does, the page sits on "Connecting…"                           | passes `--node-ip 127.0.0.1`                                              |
| reading the sign-in code from the server log | only `next dev` prints the stub email; `next start` logs that it sent nothing                                                                        | plants a known code over the real send (`code`), as the E2E helper does   |
| the captions toggle with no Translate key    | hidden (live-calls-video.md rule 19)                                                                                                                 | sets a placeholder key — desktop Chrome translates on the device          |

Two database traps for anyone editing fixture rows by hand: `psql -c "a; b"`
runs as **one transaction**, so a failure in `b` silently undoes `a`; and a
booking's `buffered_end` must move with its times, because
`bookings_no_overlap_buffered` is an exclusion constraint over it.

What this cannot show: anything that needs speech. Recognition needs a real
voice in a real microphone, so caption lines themselves are checked in unit
tests (`tests/captions/`, `tests/video/caption-band.test.tsx`), and the
rendered check covers everything around them — the toggle, the notice, the
consent prompts, the "Listening…" band.

## The landing-page clips

The home page shows the product through short recordings of the real app
(`apps/web/public/marketing/*.mp4`, played by
`components/marketing/feature-clip.tsx`). They are recorded, not drawn, and
the recording is a script so a clip can be redone when the screen it shows
changes:

```bash
pnpm call:local                              # the stack above: db, seed, LiveKit, build
pnpm --filter spiralclass-web demo:fixtures  # findings, a brief, homework, messages, materials
pnpm --filter spiralclass-web demo:record    # every clip, or `demo:record call messages`
```

`scripts/marketing/demo-fixtures.ts` writes the rows a teacher only has after
real classes, for the seed's Alicia and Carlos; `scripts/marketing/record.mjs`
signs both in, drives each screen with a visible cursor, and encodes the clip
and its poster with ffmpeg. The call clip is recorded from the student's side
with the teacher's microphone fed a voice file (`DEMO_MIC_WAV`), because
headless Chrome recognises English on the device; the script's header says
which two columns to set for that. `tests/marketing/landing-clips.test.ts`
holds the page's clip names to the files and to a size.

## Model evals

Six files ask a model for words, and every unit test of them mocks the client.
The evals are how the output itself is measured
([D-201](../decisions/D-201.md)). They are not tests: a run scores rather than
passes, spends money, and needs the network, so it is never a gate step. What
the gate holds is the registry — `apps/web/src/lib/evals/registry.ts` lists
every call site, `tests/config/ai-evals.test.ts` fails on one that is missing,
and the surfaces with no eval set are a list that may only shrink.

```bash
pnpm evals                                   # committed cases, production models
pnpm evals -- --out evals/runs/before.json   # save the run (evals/runs/ is gitignored)
pnpm evals -- --model <candidate> --out evals/runs/after.json --baseline evals/runs/before.json
pnpm evals -- --record evals/runs/a          # keep every output, for re-scoring
pnpm evals -- --replay evals/runs/a          # score recorded outputs: no key, no network
```

A case is a JSON file under `apps/web/evals/cases/<surface>/`: the input the
surface takes and what a good answer must and must not do, in terms a function
can check — the student's quoted words were actually said, the timestamp lands
on the cited line, a pronunciation finding without audio scores has a teacher
signal, a quoted span in a homework correction appears in the submission.
Whether a finding is _insightful_ is the teacher's call, and her confirm/dismiss
verdicts are read back on the admin overview rather than guessed at here.

A live run takes `ANTHROPIC_API_KEY` from the process environment — exported in
your shell, or `ANTHROPIC_API_KEY=… pnpm evals`. The committed local env holds
no vendor key on purpose, and a package script may not read a private env file
(`tests/config/no-private-env-files.test.ts`). Replay needs no key.

**Committed cases are synthetic.** A real lesson is personal data; keep those
outside the repository and point `EVAL_CASES_DIR` at them. The guard rejects
an email address or a phone number in a committed case.

**A PR that changes a prompt builder or a model constant quotes two runs**, the
baseline and the change, from `--out` and `--baseline`. A reviewer who does not
see the numbers asks for them.

## The rule

**A change is not done until it ships with tests** covering the new behaviour,
and the regression if it is a fix. There is one client, so that means web tests.
