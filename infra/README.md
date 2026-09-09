# infra/ — OpenTofu modules

Each subdirectory is an independent OpenTofu root module (its own state,
its own `main.tf`). See each module's own README for what it provisions.

## Shared state backend

Every module whose state lives in the `agendaprofe-tofu-state` Cloudflare
R2 bucket via bare `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` auth points
`tofu init -backend-config=` at the **one shared, committed
[`backend.hcl.example`](./backend.hcl.example)**, copied to a gitignored `backend.hcl`, in this directory — currently
`cloudflare-r2` alone (`oracle-runner` also did, until it was deleted for
never having been applied — D-139; `database/supabase` also did, until it
was retired — D-89 — and removed from the repo; `hetzner-runner` also did,
until it was replaced by a standalone infrastructure repo and removed). It carries only
`bucket` and `endpoints` (the R2 account id embedded in the endpoint URL);
neither is secret. Each module's own `main.tf` still sets its own `key`
(state-file path, concern-keyed per D-49) directly in its `backend "s3"`
block — Tofu backend blocks can't read variables, so that part genuinely
can't be shared, only the bucket+endpoint half can.

Originally every module carried its own `backend.hcl.example` (identical
content) that had to be copied and filled in with the same account id —
`infra/cloudflare-r2/backend.hcl` was the one already-committed exception
(gitignore carve-out). One shared file replaces all of that: nothing to
copy, nothing to keep in sync, one place to update if the R2 account ever
changes.

**`infra/aws-ses` is the deliberate exception** — it needs an extra
`profile` key (a named AWS CLI profile, not bare env vars) to avoid
colliding with its own `provider "aws"` block's real-AWS credentials (see
that module's `backend.hcl.example`), so it keeps its own separate,
still-gitignored `backend.hcl`.

## Shared Infisical project link

Every module that pulls provisioning secrets from Infisical's `infra`
environment points `infisical run`/`infisical export` at **one shared
`infra/infisical/.infisical.json`** — gitignored since D-158 and created from
its committed
[`.infisical.json.example`](./infisical/.infisical.json.example) via
`--project-config-dir=../infisical`, instead of each module running its own
`infisical init`. It carries only a project ID — not a secret.

Kept at `infra/infisical/` specifically (not moved to this top-level
directory, unlike `backend.hcl`) because `push-fly-secrets.sh` in that
directory still hardcodes `.infisical.json` living right there — relocating
it would break that script. (`seed-preview.sh` and the other task scripts in
that directory now go through `with-secret.sh`'s shared helper instead,
which resolves the file relative to itself rather than assuming
co-location — see `infra/infisical/README.md`'s "Adding a new script"
section — but `push-fly-secrets.sh` hasn't been migrated onto that helper
yet.) Every other module (`cloudflare-r2`) references it via the flag instead.

**`--project-config-dir` only exists on `infisical run`** (confirmed via
`infisical run --help` in this session) — `infisical export`/
`infisical secrets set`/etc. don't have it (confirmed via their own
`--help`), so a script that calls those directly (not wrapped in
`infisical run`) needs a subshell `cd ../infisical` instead, not the flag.
`infra/aws-ses/push-infisical-secrets.sh` is the one example of this in
the repo.

## Modules

| Module          | Provisions                                                        | Backend                       | Infisical link                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare-r2` | R2 buckets + tokens for app storage                               | shared `backend.hcl`          | `--project-config-dir=../infisical`                                                                                                                                                               |
| `infisical`     | Not a Tofu module — scripts + the shared `.infisical.json` itself | —                             | canonical location                                                                                                                                                                                |
| `aws-ses`       | SES sender IAM user + Cloudflare DNS for email                    | own `backend.hcl` (see above) | `push-infisical-secrets.sh` `cd`s into `../infisical` for its `infisical secrets set` calls — that subcommand has no `--project-config-dir` flag (unlike `infisical run`), confirmed via `--help` |

`database/supabase` (the original Supabase-project Tofu module) was removed
from the repo entirely — Supabase itself is fully decommissioned (D-89) and
the module's own status had already said "kept for history" for a while
before it was actually deleted. Its layer-1 slot in the D-49 region-migration
runbook (`infra/database/RUNBOOK.md`) is Neon's now — see
`infra/database/neon/README.md`, which is a manual/console runbook, not a
Tofu module.

`oracle-runner` and `cloudflare` were both deleted in
[D-139](../docs/decisions/D-139.md): neither had ever been applied, neither
had a state file, and both asserted a configuration that had really been
built and changed by hand. The Oracle box is now described by
[`docs/deployment/ORACLE_BOX_REBUILD.md`](../docs/deployment/ORACLE_BOX_REBUILD.md),
transcribed from the running machine; the Cloudflare Access gate is described
in [`docs/deployment/DOCS_SITE.md`](../docs/deployment/DOCS_SITE.md). Both are
prose runbooks over hand-managed infrastructure, which is what they were in
reality all along.
