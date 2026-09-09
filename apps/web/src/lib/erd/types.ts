// Shape of the generated ERD schema graph (src/lib/erd/schema.generated.json),
// produced by scripts/generate-erd-schema.mjs from the canonical DBML. This is
// the contract the admin ERD page consumes — see docs/architecture/ERD.md.

export type ErdCardinality = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

export interface ErdColumn {
  name: string;
  /** Rendered type, e.g. "String", "Int", "Decimal(10,2)". */
  type: string;
  note: string | null;
  isPrimaryKey: boolean;
  /** True when this column is the source (FK-holding) side of a relationship. */
  isForeignKey: boolean;
  isUnique: boolean;
  isNotNull: boolean;
  /** True when the column's type is a DBML enum defined in this schema. */
  isEnum: boolean;
  enumName: string | null;
  /** Rendered default value, or null when the column has none. */
  default: string | null;
}

export interface ErdIndex {
  name: string | null;
  columns: string[];
  isUnique: boolean;
  isPrimaryKey: boolean;
  type: string | null;
  note: string | null;
}

export interface ErdTable {
  /** Schema-qualified id, e.g. "public.teachers". Stable node identity. */
  id: string;
  name: string;
  schema: string;
  note: string | null;
  columns: ErdColumn[];
  indexes: ErdIndex[];
  primaryKey: string[];
}

export interface ErdRelationshipEndpoint {
  /** Table id (schema-qualified), e.g. "public.bookings". */
  table: string;
  columns: string[];
}

export interface ErdRelationship {
  id: string;
  name: string | null;
  onDelete: string | null;
  onUpdate: string | null;
  cardinality: ErdCardinality;
  /** FK-holding side. */
  source: ErdRelationshipEndpoint;
  /** Referenced (parent) side. */
  target: ErdRelationshipEndpoint;
}

export interface ErdEnum {
  name: string;
  schema: string;
  values: string[];
}

export interface ErdSchemaGraph {
  generatedFrom: string;
  schemas: string[];
  enums: ErdEnum[];
  tables: ErdTable[];
  relationships: ErdRelationship[];
}
