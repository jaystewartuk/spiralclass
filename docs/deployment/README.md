# Deployment and operations

Operator runbooks for releasing and running SpiralClass. They are procedures
followed with production credentials in hand, which is why they are the one
place in `docs/` that keeps UPPERCASE filenames.

How a change gets _to_ a release is
[development/workflow.md](../development/workflow.md).

## Releasing

| File                                             | What it is for                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RELEASE_AND_STAGING.md](RELEASE_AND_STAGING.md) | Approving a release, promoting and deploying by hand, rollback, Cloud Run, moving the domain, maintenance windows, the unscheduled maintenance jobs, one-time setup |
| [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md)     | What `main` and `production` require, `PROMOTE_TOKEN`, and how to re-apply it all with `scripts/setup-branch-protection.sh`                                         |

## When something is wrong

| File                                         | What it is for                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Security and operational response, checklist-shaped, including secret rotation         |
| [DB_BACKUP_RESTORE.md](DB_BACKUP_RESTORE.md) | Neon PITR, pre-migration checkpoint branches, the restore procedure, the off-Neon dump |

## Platform and cost

| File                                                               | What it is for                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [`infra/gcp/README.md`](../../infra/gcp/README.md)                 | The Cloud Run production target's one-time setup ([D-184](../decisions/D-184.md)) |
| [`infra/gcp-livekit/README.md`](../../infra/gcp-livekit/README.md) | The LiveKit video server production uses today ([D-16](../decisions/D-16.md))     |
| [COST_PLAYBOOK.md](COST_PLAYBOOK.md)                               | What each hosted dependency costs at this scale, and the order to start paying in |

## Scripts in this folder

| Script                                               | What it does                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`livekit-activity.sh`](livekit-activity.sh)         | `pnpm livekit:activity` — live room and participant table from production's LiveKit server, via the `lk` CLI              |
| [`livekit-activity-ink.sh`](livekit-activity-ink.sh) | `pnpm livekit:activity:ink` — the same, as the Ink dashboard in `packages/livekit-activity-cli`                           |
| [`livekit-credentials.sh`](livekit-credentials.sh)   | Sourced by the two above: exports production's LiveKit URL and key pair from Infisical without writing the secret to disk |

## The former Oracle box

The Oracle A1 box that ran LiveKit and preview was destroyed on 2026-09-19 and
could not be relaunched ([D-16](../decisions/D-16.md)). Nothing described in
these files is running.
[`infra/oracle-box/`](../../infra/oracle-box/README.md) is the unapplied module
for it ([D-184](../decisions/D-184.md)); preview's planned return is a Cloud Run
service instead ([D-199](../decisions/D-199.md)).

- [ORACLE_LIVEKIT_PRODUCTION.md](ORACLE_LIVEKIT_PRODUCTION.md) — the box as it
  ran, and what building it by hand taught (the two firewall layers).
- [ORACLE_BOX_REBUILD.md](ORACLE_BOX_REBUILD.md) — the hand rebuild procedure,
  observed from the running box.
- `oracle-*.sh` — the launch, provisioning, cloud-init and cleanup scripts those
  two runbooks call.

> [!NOTE]
> **The secrets-rotation runbook is not in this repository.** It mapped every
> credential, where it lives and what it reaches — no values, but a map of the
> estate, useful to an attacker and to no reader here. It is kept privately;
> [`../security.md`](../security.md) describes the split between the committed
> non-secret configuration and everything else.

## Related

- [Architecture overview](../architecture/overview.md) — what is being deployed
- [Security posture](../security.md) — how configuration and secrets are split
- [`infra/`](../../infra/README.md) — the OpenTofu modules
