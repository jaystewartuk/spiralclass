# Database ERD (`/admin/database`)

An interactive entity-relationship diagram of the schema, rendered inside the
admin console. It is generated **from `schema.prisma`**, not hand-drawn and not
parsed from migration history, so it cannot describe an older database without
a test failing.

- **Page:** `apps/web/src/app/admin/database/page.tsx` — `superadmin`, or the
  `schema:view` capability that the narrow `engineer` role holds
  ([D-25](../decisions/D-25.md)).
- **Stack:** [React Flow](https://reactflow.dev) (`@xyflow/react`) for the
  canvas, [ELK.js](https://github.com/kieler/elkjs) (`layered` algorithm) for
  automatic layout.

## The pipeline

```
apps/web/prisma/schema.prisma         ← the single source of truth
      │  prisma generate  (postinstall — runs the `generator dbml` block)
      ▼
apps/web/dbml/schema.dbml             ← gitignored, fully derived
      │  scripts/generate-erd-schema.mjs   (@dbml/core parse → flat graph)
      ▼
apps/web/src/lib/erd/schema.generated.json   ← committed; the ERD's only input
      │  static import at build time
      ▼
/admin/database  →  React Flow + ELK  →  interactive diagram
```

1. **Schema → DBML.** The `generator dbml` block in `schema.prisma`
   ([`prisma-dbml-generator`](https://github.com/notiz-dev/prisma-dbml-generator))
   writes `apps/web/dbml/schema.dbml` on every `prisma generate`, which the web
   app's `postinstall` runs. The DBML is gitignored: it is derived, and is the
   current-state schema (migrations describe change over time, not the
   present).
2. **DBML → JSON graph.** `apps/web/scripts/generate-erd-schema.mjs` parses the
   DBML with [`@dbml/core`](https://www.npmjs.com/package/@dbml/core) and writes
   tables, columns (types, PK/FK/unique/not-null/enum flags, defaults), indexes,
   relationships (cardinality and referential actions), enums and schemas to
   `apps/web/src/lib/erd/schema.generated.json`. The shape is typed in
   `src/lib/erd/types.ts`. The browser never parses DBML; the page has no
   runtime database or DBML dependency.

## After a schema change

```bash
# Migrating already regenerates the ERD JSON:
pnpm --filter spiralclass-web prisma:migrate

# Or regenerate just the JSON:
pnpm --filter spiralclass-web erd:generate
```

Commit `src/lib/erd/schema.generated.json` with the schema change. Neither
generated file is ever hand-edited.

If you added an admin page for a table, add it to `src/lib/erd/admin-routes.ts`
so the ERD's "Open in admin" deep-link appears for that table. Keep that map to
routes that exist.

### The drift guard

`apps/web/tests/erd-schema.test.ts` regenerates the graph from the current DBML
and asserts it matches the committed JSON byte for byte. It runs in the web
unit step of the fast gate, so a schema change without a regenerated JSON fails
with:

```
committed JSON matches what the generator produces from the current DBML
```

The fix is always `pnpm --filter spiralclass-web erd:generate`, then commit.
The same test asserts structural invariants: every relationship endpoint
resolves to a real table and column, FK columns are flagged, cardinalities are
known.

> [!NOTE]
> `postinstall` regenerates only the **DBML**, never the JSON. That is what
> lets the guard compare your committed JSON against a freshly derived schema
> instead of silently overwriting it.

## Files

| Path                                                | Role                                 |
| --------------------------------------------------- | ------------------------------------ |
| `apps/web/prisma/schema.prisma` (`generator dbml`)  | Schema → DBML                        |
| `apps/web/dbml/schema.dbml`                         | Derived DBML (gitignored)            |
| `apps/web/scripts/generate-erd-schema.mjs`          | DBML → JSON graph (+ `.d.mts` types) |
| `apps/web/src/lib/erd/schema.generated.json`        | The committed graph the page renders |
| `apps/web/src/lib/erd/types.ts`                     | Graph TypeScript contract            |
| `apps/web/src/lib/erd/layout.ts`                    | ELK layout                           |
| `apps/web/src/lib/erd/admin-routes.ts`              | Table → admin-route deep-link map    |
| `apps/web/src/app/admin/database/page.tsx`          | Server page (auth-gated)             |
| `apps/web/src/app/admin/database/erd-viewer.tsx`    | React Flow canvas and interactions   |
| `apps/web/src/app/admin/database/table-node.tsx`    | Custom table node                    |
| `apps/web/src/app/admin/database/details-panel.tsx` | Table / relationship inspector       |
| `apps/web/tests/erd-schema.test.ts`                 | Drift guard + structural invariants  |
