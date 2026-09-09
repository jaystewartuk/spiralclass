// ERD schema-graph generator.
//
// Pipeline (see docs/architecture/ERD.md and prisma/schema.prisma):
//
//   prisma/schema.prisma
//        │  prisma generate  (postinstall — runs prisma-dbml-generator)
//        ▼
//   apps/web/dbml/schema.dbml            (canonical DBML, gitignored — derived)
//        │  this script  (@dbml/core parse → clean graph)
//        ▼
//   apps/web/src/lib/erd/schema.generated.json   (committed — consumed by the ERD page)
//
// The admin ERD page statically imports the JSON; it never parses DBML at
// runtime. Regenerate with `pnpm --filter spiralclass-web erd:generate`; a
// unit test (tests/erd-schema.test.ts) proves the committed JSON matches what
// this script produces from the current DBML, so a stale copy fails CI.
//
// Plain ESM (not TS) on purpose: it runs under bare `node` in postinstall,
// with no tsx/ts-node on the path in every environment. The consumed shape is
// typed in src/lib/erd/types.ts and asserted by the test.
import { Parser } from "@dbml/core";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DBML_PATH = join(HERE, "..", "dbml", "schema.dbml");
export const OUTPUT_PATH = join(HERE, "..", "src", "lib", "erd", "schema.generated.json");

const GENERATED_FROM = "prisma/schema.prisma → prisma-dbml-generator → @dbml/core";

/** Render a DBML field/enum type into a display string, e.g. "Decimal(10,2)". */
function renderType(type) {
  if (!type) return "unknown";
  const name = type.type_name ?? "unknown";
  const args = type.args ? String(type.args).trim() : "";
  return args ? `${name}(${args})` : name;
}

/** Normalise a DBML default (`dbdefault`) into a display string or null. */
function renderDefault(dbdefault) {
  if (dbdefault == null) return null;
  if (typeof dbdefault === "object") {
    const value = dbdefault.value;
    if (value == null) return null;
    // `expression` defaults (e.g. now()) read best with parens; string/number
    // literals render as-is.
    return dbdefault.type === "expression" ? `${value}()` : String(value);
  }
  return String(dbdefault);
}

const schemaOf = (obj, fallback = "public") => obj?.schema?.name ?? obj?.schemaName ?? fallback;
const tableId = (schema, name) => `${schema}.${name}`;

/**
 * Parse a DBML document into the clean, serialisable ERD graph consumed by the
 * admin ERD page. Pure — no filesystem access — so the drift test can call it
 * directly. Deterministic: tables/enums/relationships are sorted so identical
 * input always yields byte-identical output.
 *
 * @param {string} dbml
 * @returns {import("../src/lib/erd/types").ErdSchemaGraph}
 */
export function buildErdGraph(dbml) {
  const database = new Parser().parse(dbml, "dbml");

  const enumIndex = new Map(); // bare enum name -> { name, schema, values }
  const enums = [];
  for (const schema of database.schemas) {
    for (const en of schema.enums) {
      const entry = {
        name: en.name,
        schema: schemaOf(en, schema.name),
        values: en.values.map((v) => v.name),
      };
      enums.push(entry);
      enumIndex.set(en.name, entry);
    }
  }

  // First pass: relationships (so FK columns can be flagged on their tables).
  const relationships = [];
  const fkColumns = new Map(); // tableId -> Set<columnName>
  for (const schema of database.schemas) {
    for (const ref of schema.refs) {
      // prisma-dbml-generator always emits the FK/child side first and the
      // referenced/parent side second (verified against this schema).
      const [from, to] = ref.endpoints;
      if (!from || !to) continue;
      const source = {
        table: tableId(schemaOf(from, schema.name), from.tableName),
        columns: [...from.fieldNames],
      };
      const target = {
        table: tableId(schemaOf(to, schema.name), to.tableName),
        columns: [...to.fieldNames],
      };
      const cardinality = cardinalityOf(from.relation, to.relation);

      if (!fkColumns.has(source.table)) fkColumns.set(source.table, new Set());
      for (const col of source.columns) fkColumns.get(source.table).add(col);

      relationships.push({
        id: `${source.table}(${source.columns.join(",")})->${target.table}(${target.columns.join(",")})`,
        name: ref.name ?? null,
        onDelete: ref.onDelete ?? null,
        onUpdate: ref.onUpdate ?? null,
        cardinality,
        source,
        target,
      });
    }
  }

  // Second pass: tables.
  const tables = [];
  for (const schema of database.schemas) {
    for (const table of schema.tables) {
      const id = tableId(schemaOf(table, schema.name), table.name);
      const tableFks = fkColumns.get(id) ?? new Set();

      const columns = table.fields.map((field) => {
        const typeName = field.type?.type_name ?? null;
        const enumHit = typeName ? (enumIndex.get(typeName) ?? null) : null;
        return {
          name: field.name,
          type: renderType(field.type),
          note: field.note ?? null,
          isPrimaryKey: Boolean(field.pk),
          isForeignKey: tableFks.has(field.name),
          isUnique: Boolean(field.unique),
          isNotNull: Boolean(field.not_null),
          isEnum: Boolean(enumHit),
          enumName: enumHit ? enumHit.name : null,
          default: renderDefault(field.dbdefault),
        };
      });

      const indexes = (table.indexes ?? []).map((idx) => ({
        name: idx.name ?? null,
        columns: (idx.columns ?? []).map((c) => (c.type === "column" ? c.value : `(${c.value})`)),
        isUnique: Boolean(idx.unique),
        isPrimaryKey: Boolean(idx.pk),
        type: idx.type ?? null,
        note: idx.note ?? null,
      }));

      const primaryKey = [
        ...columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
        ...indexes.filter((i) => i.isPrimaryKey).flatMap((i) => i.columns),
      ].filter((v, i, arr) => arr.indexOf(v) === i);

      tables.push({
        id,
        name: table.name,
        schema: schemaOf(table, schema.name),
        note: table.note ?? null,
        columns,
        indexes,
        primaryKey,
      });
    }
  }

  tables.sort((a, b) => a.id.localeCompare(b.id));
  enums.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  relationships.sort((a, b) => a.id.localeCompare(b.id));

  const schemas = [...new Set(tables.map((t) => t.schema))].sort();

  return { generatedFrom: GENERATED_FROM, schemas, enums, tables, relationships };
}

function cardinalityOf(fromRelation, toRelation) {
  const many = (r) => r === "*";
  if (many(fromRelation) && !many(toRelation)) return "many-to-one";
  if (!many(fromRelation) && many(toRelation)) return "one-to-many";
  if (many(fromRelation) && many(toRelation)) return "many-to-many";
  return "one-to-one";
}

/** Stable, pretty JSON with a trailing newline (git-diff friendly). */
export function serializeGraph(graph) {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

function main() {
  if (!existsSync(DBML_PATH)) {
    // Soft-fail so a fresh install (where `prisma generate` hasn't produced the
    // DBML yet) can't break `pnpm install`. The committed JSON stays in place.
    console.warn(
      `[erd] ${DBML_PATH} not found — skipping ERD schema generation. ` +
        `Run \`prisma generate\` first, then \`pnpm erd:generate\`.`,
    );
    return;
  }
  const dbml = readFileSync(DBML_PATH, "utf8");
  const graph = buildErdGraph(dbml);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, serializeGraph(graph));
  console.log(
    `[erd] wrote ${OUTPUT_PATH} (${graph.tables.length} tables, ` +
      `${graph.relationships.length} relationships, ${graph.enums.length} enums)`,
  );
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    // Never hard-fail postinstall; surface loudly instead.
    console.error("[erd] schema generation failed:", err);
    process.exitCode = 0;
  }
}
