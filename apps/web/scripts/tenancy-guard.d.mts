// Types for the tenancy guardrail scanner (scripts/tenancy-guard.mjs). Kept as
// a sibling declaration for the same reason i18n-guard.d.mts is: the scanner
// stays a plain runnable .mjs (no build step for
// `node scripts/tenancy-guard.mjs --generate`) while the ratchet test imports
// it with full types.
export const WEB_SRC: string;
export const SCHEMA_PATH: string;
export const BASELINE_PATH: string;
export const PRISMA_OPS: Set<string>;

/** How strongly a query constrains itself to one tenant. */
export type Evidence = "scoped" | "derived" | "opaque" | "negated" | "vacuous" | "none";

export interface Finding {
  line: number;
  model: string;
  op: string;
  evidence: Evidence;
}

export interface Exemption extends Finding {
  file?: string;
  reason: string;
}

/** Tenant-owned models, read out of schema.prisma as camelCase client names. */
export function tenantModels(schemaPath?: string): Set<string>;

/** Strongest scope evidence in one `where`/`data` object literal. Exported so
 * the guard test can assert the decoy shapes directly. */
export function scopeEvidence(node: unknown, negated?: boolean, derived?: Set<string>): Evidence;

/** Unscoped queries and exempted call sites in one source file. */
export function scanSource(
  fileName: string,
  source: string,
  models?: Set<string>,
): { violations: Finding[]; exemptions: Exemption[] };

/** Every unscoped query in the tree, grouped by src-relative path. */
export function collectFindings(
  srcDir?: string,
  models?: Set<string>,
): { byFile: Record<string, Finding[]>; exemptions: Exemption[] };

/** Map of src-relative path → unscoped-query count, for the ratchet. */
export function collectCounts(srcDir?: string, models?: Set<string>): Record<string, number>;

/** Load the checked-in ratchet baseline. */
export function loadBaseline(): Record<string, number>;
