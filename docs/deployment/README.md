# Deployment and operations

Operator runbooks for releasing and running SpiralClass. These are procedures
followed with production credentials in hand, which is why they are the one
place in `docs/` that keeps UPPERCASE filenames.

For how a change gets _to_ a release, see
[development/workflow.md](../development/workflow.md).

## Releasing

- **[Release and staging](RELEASE_AND_STAGING.md)** — the normal release path in
  full: environments, rollback, maintenance windows, one-time setup.
- **[Running this repo from the laptop](LOCAL_AUTOMATION.md)** — the deploy and
  maintenance commands themselves, and what runs on a runner instead.
- **[Branch protection](BRANCH_PROTECTION.md)** — what `main` requires and how
  to re-apply it. The rule is a settings-page object, so this document and
  `scripts/setup-branch-protection.sh` are its version control.

## When something is wrong

- **[Incident response](INCIDENT_RESPONSE.md)** — security and operational
  response, checklist-shaped.
- **[Database backup and restore](DB_BACKUP_RESTORE.md)** — production recovery,
  Neon PITR and pre-migration checkpoint branches.

## Platform

- **[Oracle LiveKit production](ORACLE_LIVEKIT_PRODUCTION.md)** — the
  self-hosted video box: LiveKit, Egress and the captions agent.
- **[Oracle box rebuild](ORACLE_BOX_REBUILD.md)** — standing that box back up
  from nothing.
- **[Cost playbook](COST_PLAYBOOK.md)** — what each hosted dependency costs at
  this scale, and the levers already pulled.
- **[Docs site](DOCS_SITE.md)** — the MkDocs build behind `pnpm docs:serve`.

> **The secrets-rotation runbook is not in this repository.** It named every
> credential, where it lives and what each one reaches — no values, but a map
> of the estate, which is useful to an attacker and to no reader here. It is
> kept privately; [`../security.md`](../security.md) describes the split
> between the committed non-secret configuration tier and everything else.

## Related

- [Architecture overview](../architecture/overview.md) — what is being deployed
- [Security posture](../security.md) — how configuration and secrets are split
- [`infra/`](../../infra/README.md) — the OpenTofu modules
