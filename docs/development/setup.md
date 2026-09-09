# Development setup

From a fresh clone to an app you can sign into. **No credentials are required.**
Every integration degrades to a stub when its key is missing, so what you get
without configuring anything is a working teacher dashboard, booking funnel,
student portal and admin console. Video, payments and the AI features are dark
until you supply keys; nothing else is.

## Prerequisites

| Need                 | Why                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Node 24 or newer** | `package.json` enforces `>=24.15.0`; `.nvmrc` pins 26, the major production runs           |
| **pnpm 11**          | `corepack enable` activates the version pinned in `package.json` — do not install globally |
| **Docker**           | For the local Postgres. Optional if you point `DATABASE_URL` at a hosted database instead  |

A free [Neon](https://neon.tech) branch works in place of Docker: point
`DATABASE_URL` and `DIRECT_URL` at it and skip the container.

## The short version

```bash
git clone https://github.com/jaystewartuk/spiralclass.git
cd spiralclass
pnpm setup     # install · start Postgres · migrate · seed
pnpm dev       # http://localhost:3000
```

`pnpm setup` is idempotent. Re-run it after a `git pull` to pick up new
migrations and fixtures.

## The same thing, step by step

```bash
pnpm install                                          # + prisma generate, + git hooks
pnpm db:dev:up                                        # postgres:16 on :5432
pnpm --filter spiralclass-web prisma:migrate:deploy   # apply migrations
pnpm --filter spiralclass-web seed                    # development fixtures
pnpm dev
```

`pnpm install` also runs `prisma generate` and points `core.hooksPath` at
`.githooks`, which is what makes the pre-push gate run.

## Why there is no `.env.local` to fill in

`DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET` and `APP_URL` come from
**`config/env/local.runtime.env`, which is committed on purpose.** The values
are identical for every developer and protect nothing — a Postgres reachable
only from your own machine, and a session secret guarding data that only exists
there. Committing them means a fresh checkout works with no per-developer file
to drift, to be missing, or to quietly hold a preview URL.

Copy `apps/web/.env.example` to `apps/web/.env.local` only when you want to
enable a specific integration. All 135 variables are documented there
individually, each next to the module that reads it, and `src/lib/env.ts` is the
authoritative runtime contract behind them.

The same split governs deployed environments — see
[`config/env/README.md`](../../config/env/README.md) and
[`docs/security.md`](../security.md) for why the non-secret tier is in the
repository at all.

## Signing in locally

Sign-in is a one-time code sent by email. **With no email provider configured
the message is printed to the dev server's console instead of being sent** —
look for a block headed:

```
--- email (no provider configured; not sent) ---
```

and copy the code out of it. The seed prints the teacher and student addresses
it created when it runs.

## Which services you actually need

| Service                                      | Status                  | Without it                                                           |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| PostgreSQL                                   | **Required**            | Nothing runs                                                         |
| Stripe                                       | Optional, free          | The card rail hides; the app runs transfer-only                      |
| Resend or Amazon SES                         | Optional, free tier     | Email prints to the console — which is how you sign in               |
| LiveKit                                      | Optional, self-hostable | Video is disabled; runs locally from the official Docker image       |
| Cloudflare R2                                | Optional, free tier     | Uploads fail; nothing else is affected                               |
| Deepgram, Anthropic, Azure Speech, Vertex AI | Optional, paid          | Captions, transcription, insights and image generation stay dark     |
| Sentry, PostHog                              | Optional, free tier     | No-ops when unset                                                    |
| Inngest                                      | Optional locally        | Background jobs do not fire — `npx inngest-cli dev` if you need them |

Only `assertProductionCredentials()` in `src/lib/env.ts` hard-fails on a missing
key, and only on the production deployment.

## The database

The local Postgres is `apps/web/docker-compose.dev.yml` — a `postgres:16` on
**:5432** with a named volume, deliberately separate from the integration-test
database on **:5433** (`docker-compose.test.yml`), which is wiped between runs.
Losing the database you have been clicking through to a test teardown would be a
bad afternoon.

```bash
pnpm db:dev:up      # start
pnpm db:dev:down    # stop, keep the data
pnpm --filter spiralclass-web prisma:studio   # browse it
```

Its credentials are served by that compose file and consumed from
`config/env/local.runtime.env`. **The two must agree** — changing one means
changing the other in the same commit.

### Migrations

```bash
pnpm --filter spiralclass-web prisma:migrate          # create + apply a new migration
pnpm --filter spiralclass-web prisma:migrate:deploy   # apply existing migrations
```

Creating a migration also regenerates the DBML the admin ERD renders from; a
drift guard fails if you skip it. **An applied migration is never edited**, not
even a comment — Prisma checksums each file and any change breaks
`migrate deploy`. Correct a mistake with a new migration.

Only one migration-bearing branch should be in flight at a time. Two branches
each adding a migration collide on ordering and checksums, and there is no
editing your way out afterwards.

→ [Data model](../architecture/data-model.md)

### Seed data

`pnpm --filter spiralclass-web seed` is idempotent — it clears its own fixtures
and re-inserts, so re-running is always a clean slate. It creates a
deterministic core: the teacher the end-to-end suite signs in as, her students,
and a cast covering the whole subscription matrix (Free at cap, Pro monthly and
annual, Founding, trial, past due, cancelled) and both payment rails.

Every person in it is invented. The names are declared in
`scripts/fixture-personas.json`, which is what the leak check tests fixture
names against — see [`docs/security.md`](../security.md).

## Everyday commands

| Command                       | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                    | Next.js dev server on :3000 (holds the port the E2E suite needs)     |
| `pnpm build`                  | Production build of every workspace, Turborepo-cached                |
| `pnpm typecheck`              | `tsc --noEmit` across every workspace                                |
| `pnpm lint`                   | ESLint across every workspace                                        |
| `pnpm test`                   | Unit tests — no database needed                                      |
| `pnpm test:integration:local` | Integration tests, booting their own Postgres                        |
| `pnpm test:e2e`               | Playwright                                                           |
| `pnpm format`                 | Prettier across the repository                                       |
| `pnpm gate --allow-dirty`     | Everything the pre-push hook will check, against an uncommitted tree |

`just --list` is a human-facing catalog of the same commands grouped by purpose,
and `just dev` launches `mprocs` for the long-lived dev processes. The `just`
recipes are a thin front door — they delegate to the `pnpm` commands and never
duplicate logic. Test and gate tasks are deliberately absent from the
`justfile`; invoke those through `pnpm`.

→ [Testing](testing.md) · [Workflow](workflow.md)

## When something does not start

**`corepack` is not enabling pnpm.** Node 24 ships it, but a Node installed by
some package managers disables it. `corepack enable` needs to succeed before
anything else will.

**Docker is installed but the setup script still fails.** It checks
`docker info`, not just the binary — the daemon has to be running.

**Port 5432 is already taken** by another Postgres. Stop it, or point
`DATABASE_URL`/`DIRECT_URL` at a hosted database and skip `pnpm db:dev:up`.

**Port 3000 is already taken.** Usually another `pnpm dev`, or a leftover from a
browser test run.

**Sign-in never arrives.** It is not being sent — read the dev server console
for the one-time code (see [above](#signing-in-locally)).

**A vendor feature is missing rather than erroring.** That is the design: a
missing key hides its UI. Check `src/lib/env.ts` for which variable gates it.

**Prettier reformats Tailwind classes differently from `main`.** Class ordering
depends on the installed `prettier-plugin-tailwindcss`, so a branch behind
`main` on that dependency formats differently. Rebase and `pnpm install` rather
than hand-editing toward the other ordering.

**A `git push` appears to hang.** It is almost certainly queueing for the
machine-wide gate lock behind another checkout, and it says so. `pnpm gate:lock`
shows who holds it. Do not kill it and do not reach for `SKIP_GATE=1`.
