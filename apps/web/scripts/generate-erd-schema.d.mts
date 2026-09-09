// Types for the ERD schema-graph generator (scripts/generate-erd-schema.mjs).
// Kept as a sibling declaration so the generator stays a plain runnable .mjs
// (no build step for `node scripts/generate-erd-schema.mjs`) while the drift
// test imports it with full types.
import type { ErdSchemaGraph } from "../src/lib/erd/types";

export const DBML_PATH: string;
export const OUTPUT_PATH: string;

/** Parse a DBML document into the clean, serialisable ERD graph. Pure. */
export function buildErdGraph(dbml: string): ErdSchemaGraph;

/** Stable, pretty JSON with a trailing newline. */
export function serializeGraph(graph: ErdSchemaGraph): string;
