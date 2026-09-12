# SpiralClass documentation

Organised by the question you arrived with. The [repository
README](../README.md) is the front door; this is the map behind it.

## Start here

| Question                            | Go to                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| How is this system put together?    | [architecture/overview.md](architecture/overview.md)                             |
| How does the database work?         | [architecture/data-model.md](architecture/data-model.md)                         |
| Why is it built this way?           | [decisions/](decisions/README.md#start-here)                                     |
| How do I run it?                    | [development/setup.md](development/setup.md)                                     |
| How do I test it?                   | [development/testing.md](development/testing.md)                                 |
| How does a change reach production? | [development/workflow.md](development/workflow.md)                               |
| What exactly does feature X do?     | [features/](features/)                                                           |
| How do I operate it?                | [deployment/](deployment/README.md)                                              |
| What does publishing this expose?   | [security.md](security.md)                                                       |
| How is it worked with AI agents?    | [development/ai-assisted-engineering.md](development/ai-assisted-engineering.md) |

## The sections

- **[architecture/](architecture/README.md)** — durable system design: the
  components and their boundaries, the data model, the identity model, how a
  purchase and a booking actually flow, and what was reversed along the way.
- **[decisions/](decisions/README.md)** — 123 decision records. **Current
  policy, not history**: before reversing anything a decision constrains, read
  its record first. Several reverse an earlier one and say why.
- **[features/](features/)** — the single source of truth for application
  behaviour, business rules, roles, permissions and workflows. One document per
  feature. Other documents link to these rather than restating them.
- **[development/](development/README.md)** — setup, testing, the change
  workflow, i18n and analytics conventions, and
  [how this repository is worked with AI agents](development/ai-assisted-engineering.md)
  — the context budget, the guardrails, and what was deliberately not built.
- **[deployment/](deployment/README.md)** — release, incident response, backup
  and restore, and the infrastructure runbooks.
- **[help/](help/README.md)** — customer-facing guides for teachers and
  students. This is also the source for the in-app help centre:
  `scripts/generate-help-content.mjs` parses these files into
  `packages/shared/src/content/generated.ts`, which the app renders at `/help`.
  Editing a guide here means re-running that script.
- **[design/](design/README.md)** — the design-token system, what enforces it,
  and the visual-capture database behind the regression baselines.
- **[security.md](security.md)** — what this public repository deliberately
  exposes and why each committed value is not a credential; the leak-check
  mechanism; the application's security properties, including the uncomfortable
  ones.

Infrastructure-as-code modules document themselves next to their own Terraform:
[`infra/`](../infra/README.md).

## Conventions

**Behaviour is defined once.** `features/` owns product rules. Everything else
links to a feature document rather than restating its rules, so there is never a
second source of truth to keep in step.

**Documents describe the present.** This repository holds no backlog, no
roadmap, no plans directory and no dated audit that ends in a findings list.
Open work lives in [the issues](https://github.com/jaystewartuk/spiralclass/issues)
([D-172](decisions/D-172.md)). If work falls out of a document you are writing,
file it there and keep the document to what is true now.

**A superseded document is deleted, not archived.** The decision records are
where the reasoning trail lives; a stale document beside a current one is a
second answer to the same question.

**Filenames say what a document is for.** `UPPERCASE.md` in `deployment/` is an
operator runbook — a procedure to follow with production credentials in hand.
Everything else is lowercase-kebab and is read rather than executed.

Full conventions, including where a new document goes:
[development/documentation.md](development/documentation.md).

## Reading the docs as a site

The tree builds as a searchable [MkDocs Material](https://squidfunk.github.io/mkdocs-material/)
site — `pnpm docs:serve` renders it locally at `http://localhost:8000`. The nav
mirrors the folder tree, so moving a file moves its page.
