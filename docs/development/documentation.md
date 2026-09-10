# Documentation standards

Keep documentation small, current, and single-purpose.

| Document purpose                                            | Location                                |
| ----------------------------------------------------------- | --------------------------------------- |
| Application behaviour, roles, business rules, and workflows | `docs/features/`                        |
| Customer-facing instructions                                | `docs/help/<audience>/`                 |
| Stable technical design                                     | `docs/architecture/`                    |
| Decision rationale and trade-offs                           | `docs/decisions/`                       |
| Contributor workflow, setup, testing, conventions           | `docs/development/`                     |
| Production and release runbook                              | `docs/deployment/`                      |
| Go-to-market and commercial strategy                        | **not this repo**                       |
| **Work not yet done, of any kind**                          | **an issue, never a file in this repo** |
| Replaced, concluded, or dated material                      | delete it — git history is the archive  |

## Behaviour is defined once

`docs/features/` is the canonical definition of product behaviour. Do not copy
feature descriptions, permissions, workflows, or business rules into a plan,
runbook, decision, or guide. Link to the relevant feature document instead;
describe only the technical implementation or operational concern that the
reader needs.

## Documents describe the present; the board holds the future

Every document in this tree states what is true now. Nothing here is a queue.

This was not always so: until 2026-08-08 the repository also carried
launch-blocker lists, a post-launch backlog, dated audits ending in findings,
a `docs/development/plans/` roadmap, and a 72-file archive. They were deleted
outright, not migrated. A second copy of a commitment rots while the board
moves on — the post-launch backlog was last refreshed 2026-06-07 and by August
cited 11 documentation paths that had not existed since the 2026-07-24 reorg,
plus a Supabase upgrade item that D-89 had made meaningless.

So:

- **Work owed is an issue** on this repository ([D-172](../decisions/D-172.md)),
  carrying what is wrong and a **Done when** line, so a pull request can close it
  and the closing is the only bookkeeping. Not a markdown list here, and — the
  planning board's own rule — an undated idea is an issue, never a board row.
- **Do not add** a `TODO.md`, `BACKLOG.md`, `LAUNCH_BLOCKERS.md`, a `plans/`
  directory, or an audit whose last section is a list of things to fix. If an
  investigation produces work, the finding goes on the board and the document
  keeps only what it established.
- **Do not archive — delete.** Git history is the archive, and unlike a
  directory it cannot be mistaken for current policy.

## Filenames

`UPPERCASE.md` in `docs/deployment/` means an **operator runbook** — a procedure
followed with production credentials in hand. Everything else in `docs/` is
lowercase-kebab and is read rather than executed. Keeping the two visually
distinct is worth more than uniformity.

An applied migration, a decision record number, and a document an ADR cites are
all things other files point at. Renaming one means repointing every reference
in the same change — including the ones inside decision records, which the
`doc-paths` guard test will otherwise catch.

## Maintenance

Update a living document when its subject changes. When a document is replaced
or concluded, delete it in the same change that supersedes it.

Two mechanical guards keep this honest, and neither can be satisfied by editing
prose:

- **`apps/web/tests/config/doc-paths.test.ts`** fails if any `docs/…` path
  written anywhere in the repository names a file that does not exist. Its
  exception list is a ratchet: an entry with no references left must be removed,
  and nothing may be added — a new dangling path means a document moved without
  its references, and the fix is to update them.
- **`apps/web/tests/config/doc-links.test.ts`** fails if a relative link in any
  Markdown file does not resolve to a real file.

A number stated in prose is a claim, and a claim nothing verifies is a claim
that is eventually false — `scripts/readme-counts.mjs` recounts the ones in the
README and the architecture docs from the tree on every run of the gate. Adding
a number to those documents means adding it there.
