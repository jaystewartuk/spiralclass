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

- **[The LiveKit box on Compute Engine](../../infra/gcp-livekit/README.md)** —
  the self-hosted video server production uses today
  ([D-16](../decisions/D-16.md)).
- **[Cloud Run](../../infra/gcp/README.md)** — the production web target's
  one-time setup ([D-184](../decisions/D-184.md)).
- **[Oracle LiveKit production](ORACLE_LIVEKIT_PRODUCTION.md)** and
  **[Oracle box rebuild](ORACLE_BOX_REBUILD.md)** — the former video box,
  destroyed on 2026-09-19 ([D-16](../decisions/D-16.md)). Kept as the record
  of the Oracle way back, not a description of anything running.
- **[Cost playbook](COST_PLAYBOOK.md)** — what each hosted dependency costs at
  this scale, and the levers already pulled.

> **The secrets-rotation runbook is not in this repository.** It named every
> credential, where it lives and what each one reaches — no values, but a map
> of the estate, which is useful to an attacker and to no reader here. It is
> kept privately; [`../security.md`](../security.md) describes the split
> between the committed non-secret configuration tier and everything else.

## Related

- [Architecture overview](../architecture/overview.md) — what is being deployed
- [Security posture](../security.md) — how configuration and secrets are split
- [`infra/`](../../infra/README.md) — the OpenTofu modules
