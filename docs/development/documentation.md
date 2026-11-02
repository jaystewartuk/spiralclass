# Documentation standards

Keep documentation small, current and single-purpose. GitHub's Markdown
rendering is the only surface these documents have: there is no docs site and
no build step, so a document is finished when it reads correctly on GitHub.

## Where a document goes

| Document purpose                                            | Location                                |
| ----------------------------------------------------------- | --------------------------------------- |
| Application behaviour, roles, business rules, and workflows | `docs/features/`                        |
| Customer-facing instructions                                | `docs/help/<audience>/`                 |
| Stable technical design                                     | `docs/architecture/`                    |
| Visual design and what enforces it                          | `docs/design/`                          |
| Decision rationale and trade-offs                           | `docs/decisions/`                       |
| Contributor workflow, setup, testing, conventions           | `docs/development/`                     |
| Production and release runbooks                             | `docs/deployment/`                      |
| Go-to-market and commercial strategy                        | **not this repo**                       |
| **Work not yet done, of any kind**                          | **an issue, never a file in this repo** |
| Replaced, concluded, or dated material                      | delete it — git history is the archive  |

## Behaviour is defined once

`docs/features/` is the canonical definition of product behaviour. Do not copy
feature descriptions, permissions, workflows or business rules into a runbook,
decision or guide. Link to the feature document and describe only the technical
or operational concern the reader needs.

The same rule applies everywhere: each fact has one home, and every other
document links to it.

## Documents describe the present

Every document states what is true now. Nothing here is a queue
([D-164](../decisions/D-164.md)).

- **Work owed is an issue** on this repository, with what is wrong and a
  **Done when** line, so a pull request can close it.
- **Do not add** a `TODO.md`, a backlog, a `plans/` directory, or an audit whose
  last section is a list of things to fix. If an investigation produces work,
  file the finding as an issue and keep only what it established.
- **Do not archive — delete.** Git history is the archive, and unlike a
  directory it cannot be mistaken for current policy.
- **Cut history and narration.** "On 2026-09-04 we…" belongs in the commit
  message or a decision record. A document keeps what a reader would act on;
  the reasoning is linked to its `D-NN` record in `docs/decisions/`, not
  retold.

## Writing for GitHub

- **Every folder has a `README.md`** listing each file in it and what it is for.
  GitHub renders it under the folder listing, so it is the folder's front page.
- **Links are relative and name the file, extension included** —
  `[Testing](testing.md)`, `[D-157](../decisions/D-157.md)`. GitHub resolves a
  link to exactly the path written; an extensionless link is a 404 there. A
  link to a folder is fine and renders its `README.md`.
- **Callouts are GitHub alerts**, the only kind GitHub renders:

  ```markdown
  > [!NOTE]
  > Background a reader may want.

  > [!IMPORTANT]
  > Something the reader must do.

  > [!WARNING]
  > Something that breaks or loses data if ignored.
  ```

  Never MkDocs syntax — `!!! note`, `??? note`, `=== "Tab"`, `{ .class }`
  attributes. GitHub prints it as literal text.

- **Diagrams are Mermaid** in a fenced `mermaid` block, which GitHub renders.

## Filenames

`UPPERCASE.md` in `docs/deployment/` means an **operator runbook** — a procedure
followed with production credentials in hand. Everything else in `docs/` is
lowercase-kebab and is read rather than executed.

A decision record number, an applied migration, and a document an ADR cites
are all things other files point at. Renaming one means repointing every
reference in the same change, including those inside decision records.

## Maintenance

Update a living document when its subject changes. When a document is replaced
or concluded, delete it in the same change that supersedes it.

Three mechanical guards keep the tree honest, and none can be satisfied by
editing prose:

- **`apps/web/tests/config/doc-paths.test.ts`** fails if any `docs/…` path
  written anywhere in the repository names a file that does not exist. Its
  exception list is a ratchet: an entry nothing references must be removed, and
  nothing may be added.
- **`apps/web/tests/config/doc-links.test.ts`** fails if a relative link in any
  Markdown file does not resolve to a file or folder exactly as written, and if
  any line opens with an MkDocs admonition. It has no exception list.
- **`scripts/readme-counts.mjs`** recounts every number stated in the front-door
  documents (the `CHECKED` list at its top) from the tree, on every run of the
  gate. A number stated in prose is a claim, and a claim nothing verifies is a
  claim that is eventually false: adding a number to one of those documents
  means adding it there.
