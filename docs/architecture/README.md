# Architecture

How the system is put together and why the boundaries fall where they do. For
what the product _does_, see [features/](../features/); for the reasoning behind
a specific choice, see the [decision record](../decisions/README.md) it names.

- **[System overview](overview.md)** — start here. Components and their
  boundaries, how a purchase and a booking flow through them, the cross-cutting
  concerns, and what was reversed along the way.
- **[Data model](data-model.md)** — tenancy, money, concurrency in the database,
  closed unions, and migration discipline.
- **[Multi-teacher students](multi-teacher-students.md)** — the identity model:
  per-teacher rows, read-time aggregation, and the two preferences allowed to
  cross it.
- **[Visual content in materials](material-visuals.md)** — how a picture reaches
  a material, what each of the three renderers can draw, and the
  no-markup-sink boundary that shapes every future visual block type.
- **[Entity-relationship diagram](ERD.md)** — how `/admin/database` generates and
  renders the live schema ERD, and the drift guard behind it.

## Related

- [Development](../development/README.md) — setup, testing, the change workflow
- [Decision records](../decisions/README.md) — the reasoning, in full
- [Deployment](../deployment/README.md) — how it runs in production
