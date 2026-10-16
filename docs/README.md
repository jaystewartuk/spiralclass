# SpiralClass documentation

Organised by the question you arrived with. The [repository README](../README.md)
is the front door; this is the map behind it. Every folder below has its own
`README.md` listing what is in it, except `assets/`, which is described here.

## Start here

| Question                            | Go to                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| How is this system put together?    | [architecture/overview.md](architecture/overview.md)                             |
| How does the database work?         | [architecture/data-model.md](architecture/data-model.md)                         |
| Why is it built this way?           | [decisions/README.md](decisions/README.md#start-here)                            |
| How do I run it?                    | [development/setup.md](development/setup.md)                                     |
| How do I test it?                   | [development/testing.md](development/testing.md)                                 |
| How does a change reach production? | [development/workflow.md](development/workflow.md)                               |
| What exactly does feature X do?     | [features/README.md](features/README.md)                                         |
| How do I operate it?                | [deployment/README.md](deployment/README.md)                                     |
| What does publishing this expose?   | [security.md](security.md)                                                       |
| How is it worked with AI agents?    | [development/ai-assisted-engineering.md](development/ai-assisted-engineering.md) |

## The folders

- **[architecture/](architecture/README.md)** — durable system design: the
  components and their boundaries, the data model, the identity model for a
  student with several teachers, how visual content reaches a material, and how
  the admin ERD is generated.
- **[decisions/](decisions/README.md)** — more than 25 decision records.
  **Current policy, not history**: before reversing anything a decision
  constrains, read its record first. Several reverse an earlier one and say why.
  [READ-THIS-FIRST.md](decisions/READ-THIS-FIRST.md) tells two of them in full.
- **[features/](features/README.md)** — the single source of truth
  for application behaviour, business rules, roles, permissions and workflows.
  One document per feature; other documents link to these rather than restating
  them.
- **[development/](development/README.md)** — setup, testing, the change
  workflow, i18n and analytics conventions, documentation conventions, and how
  this repository is worked with AI agents.
- **[deployment/](deployment/README.md)** — release, branch protection, incident
  response, backup and restore, cost, and the infrastructure runbooks with the
  scripts they run.
- **[help/](help/README.md)** — customer-facing guides for teachers and
  students, one file per language (`<slug>.md`, `<slug>.es.md`,
  `<slug>.fr.md`). They are also the source of the in-app help centre:
  [`scripts/generate-help-content.mjs`](../scripts/generate-help-content.mjs)
  compiles them into `packages/shared/src/content/generated.ts`, which the app
  renders at `/help`, so editing a guide means re-running that script.
- **[design/](design/README.md)** — the design-token system, what enforces it,
  and the visual-capture evidence behind the regression baselines.
- **[assets/](assets/)** — the three screenshots the repository README shows:
  the teacher dashboard, the public booking funnel and the design-system page,
  each rendered from invented fixture data.
- **[security.md](security.md)** — what this public repository deliberately
  exposes and why each committed value is not a credential, the leak checks that
  keep it that way, and the application's security properties, including the
  uncomfortable ones.

Infrastructure-as-code modules document themselves beside their own code, in
[`infra/`](../infra/README.md).

## Conventions

**Behaviour is defined once.** `features/` owns product rules. Everything else
links to a feature document rather than restating its rules, so there is never a
second source of truth to keep in step.

**Documents describe the present.** This repository holds no backlog, no
roadmap, no plans directory and no dated audit that ends in a findings list.
Open work lives in [the issues](https://github.com/jaystewartuk/spiralclass/issues)
([D-164](decisions/D-164.md)). If work falls out of a document you are writing,
file it there and keep the document to what is true now.

**A superseded document is deleted, not archived.** The decision records are
where the reasoning trail lives; a stale document beside a current one is a
second answer to the same question.

**Filenames say what a document is for.** `UPPERCASE.md` in `deployment/` is an
operator runbook — a procedure to follow with production credentials in hand.
Everything else is lowercase-kebab and is read rather than executed.

**GitHub is the only renderer.** Links are relative and name the file with its
`.md` extension; callouts use GitHub alerts (`> [!NOTE]`, `> [!WARNING]`).
Two tests hold the links: every `docs/…` path written anywhere must exist, and
every relative Markdown link must resolve.

Full conventions, including where a new document goes:
[development/documentation.md](development/documentation.md).
