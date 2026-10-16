# Architecture

How the system is put together and why the boundaries fall where they do. For
what the product _does_, see [features/](../features/); for the reasoning behind
a specific choice, see the [decision record](../decisions/README.md) it names.

| File                                                   | What it is for                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [overview.md](overview.md)                             | Start here. Components and their boundaries, how a purchase, a booking and a call flow through them, the cross-cutting concerns, what was reversed |
| [data-model.md](data-model.md)                         | Tenancy and its two checks, the student identity model in brief, money columns, booking constraints, closed unions, migration discipline           |
| [multi-teacher-students.md](multi-teacher-students.md) | The identity model in full: per-teacher rows, the identity set, the mailbox-scoped exceptions, and what reads across it                            |
| [material-visuals.md](material-visuals.md)             | Pictures and drawn blocks in materials: the no-markup-sink boundary, what each renderer can draw, how to add a visual block type                   |
| [ERD.md](ERD.md)                                       | How `/admin/database` generates the schema diagram from `schema.prisma`, and the drift guard behind it                                             |

## Related

- [Development](../development/README.md) — setup, testing, the change workflow
- [Decision records](../decisions/README.md) — the reasoning, in full
- [Deployment](../deployment/README.md) — how it runs in production
