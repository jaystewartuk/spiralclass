# `config/env` — non-secret runtime & build config (single source of truth)

These files hold every **non-secret** environment value for the web app,
per environment. They replace what used to live in the Fly configs' `[env]`
and `[build.args]` tables (D-85). Genuine secrets still live in Infisical — see
`infra/infisical/README.md` and D-66.

Splitting the config out of one host's own config format is what lets **any**
environment consume it — Cloud Run, the Vercel failover and a plain local
checkout load the exact same file. That is why moving production off Fly
changed none of these values: a new host is another reader of the same file
rather than another copy of the values.

## `__LOCAL__` — values that are deliberately not in git

Some values name **the operator's own accounts** rather than demonstrating how the
system is built: an R2 bucket, a Stripe price, a Vertex project, a support
phone number. Since 2026-09-04, ahead of this repository going public, those
carry the literal value `__LOCAL__` here and their real values live in a
gitignored sibling:

```
config/env/<env>.<kind>.env         committed — every key, every comment, __LOCAL__ for the values above
config/env/<env>.<kind>.local.env   gitignored — KEY=value for those keys only
```

**The committed file stays the source of truth for which keys exist**, their
order and their documentation. The overlay supplies values and cannot add keys
— a key in the overlay that is not declared in the committed file is an error,
so the overlay can never become a second, undocumented config.

### It must never ship quietly, and three things enforce that

- **Build time** — `scripts/env-build-args.mjs` resolves through
  `resolveEnvFile` and **throws**, naming every unsatisfied key. Build args are
  baked irreversibly into the client bundle, so a placeholder reaching a build
  would ship a broken Sentry DSN to real browsers with nothing failing.
- **Deploy time** — `scripts/vercel-deploy.sh` refuses to deploy when a
  `__LOCAL__` runtime key was never pushed to the Vercel project.
  `scripts/cloudrun-deploy.sh` cannot make the same check — it holds no
  credential that can read the runtime secret, by design — so on Cloud Run the
  boot-time rule below is the one that binds.
- **Boot time** — `scripts/docker-entrypoint.sh` refuses to _export_ a
  `__LOCAL__`, logging loudly instead. Leaving it unset lets `env.ts` apply the
  variable's own absent-value behaviour, which degrades the feature cleanly;
  exporting the placeholder would point production at something that does not
  exist, which is strictly worse than the value having been in git.

### Two sources, and why the environment wins

`resolveEnvFile` fills a `__LOCAL__` from the first of these that has the key:

1. **The process environment.** This is how a CI runner supplies them — from
   repository secrets, with no file involved. ⚡ **Deployment moves to GitHub
   Actions when this repository goes public**: Actions is free on public repos,
   and the runner builds amd64 _natively_ rather than the 20-30 minute QEMU
   cross-build an arm64 laptop is stuck with. Nothing here needs changing for
   that; a workflow exports the same names.
2. **The gitignored overlay file.** The operator's machine.

Environment first, deliberately. A runner has no overlay file, and on a machine
that has one, an exported value is a deliberate act — overriding a single key
for one build should not require editing a file.

If neither has it, the build **throws** and names every missing key. There is
no third fallback, because a silent default is the failure this whole mechanism
exists to prevent.

### Setting up a fresh clone

Create the overlay files with one `KEY=value` line per `__LOCAL__` name. The
values are in Infisical `production` and in the vendor dashboards.

## Layout

Two files per environment, split by **when the value is consumed**:

| File                | Consumed                                                                   | Was            |
| ------------------- | -------------------------------------------------------------------------- | -------------- |
| `<env>.build.env`   | Build time — `NEXT_PUBLIC_*`, inlined into the client bundle by Turbopack. | `[build.args]` |
| `<env>.runtime.env` | Runtime — read from `process.env` by the server.                           | `[env]`        |

`<env>` is `preview` or `production`.

## Who loads each file

- **Image build** — `scripts/env-build-args.mjs <env>` feeds
  `<env>.build.env` to `docker buildx --build-arg` (see
  `scripts/cloudrun-deploy.sh`).
- **Container boot** — `scripts/docker-entrypoint.sh` sources
  `<env>.runtime.env` (selected by `APP_ENV`, which `scripts/cloudrun-deploy.sh`
  sets on the service) before starting the server. Already-set container env
  (`gcloud run services update --update-env-vars`) wins over the file. The
  mounted Secret Manager file of Infisical secrets is sourced **after** it, by
  the same only-if-unset rule, so it fills what this file leaves unset —
  every `__LOCAL__` included.
- **Vercel failover** ([D-177](../../docs/decisions/D-177.md)) —
  `scripts/vercel-deploy.sh` replaces what `vercel pull` writes with
  `production.build.env`'s values, and syncs `production.runtime.env` onto the
  project from the commit (`scripts/vercel-env.mjs sync-committed`). A value
  pushed from Infisical by `infra/infisical/push-vercel-env.sh` wins over the
  file, as on Cloud Run.
- **Local dev** — `apps/web`'s `dev` and `start` scripts load
  `local.runtime.env` through `dotenv` before `next` sees the process, which is
  why a fresh checkout boots with no per-developer file to fill in.

## Format (keep it boring on purpose)

Parsed by three languages (bash, Node, the same shell in Docker), so the
grammar is the strict intersection all three agree on:

- `KEY=value`, one per line. `KEY` is `UPPER_SNAKE_CASE`.
- Values are **unquoted** and contain no spaces or `#`.
- An empty value (`KEY=`) is meaningful and preserved (e.g.
  `NEXT_PUBLIC_POSTHOG_HOST=` deliberately disables the PostHog proxy bypass).
- Comments are **whole lines** starting with `#`. **No inline comments after
  a value** — an unquoted `#` mid-line is ambiguous across parsers, so put
  the note on its own line above the key.
- A commented-out `KEY` means its unset state IS the current live behavior
  (the code-level default). Uncommenting one is a real behavior change on the
  next deploy — treat it like any other code change, not a secrets sync.

`apps/web/tests/scripts/env-config.test.ts` enforces all of the above.
