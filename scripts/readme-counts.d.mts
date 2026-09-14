// Types for the front-door count checker (scripts/readme-counts.mjs). Kept as a
// sibling declaration so the checker stays a plain runnable .mjs while the
// guard test imports it with full types.

export interface Claim {
  id: string;
  actual: () => number;
  pattern: RegExp;
  /** State "more than N", N the largest multiple of this strictly below the count. */
  floor?: number;
}

export interface Reconciled {
  next: Map<string, string>;
  drift: string[];
  unstated: string[];
  unfloored: string[];
}

export function expectedFor(claim: Pick<Claim, "floor">, actual: number): number;

export function reconcile(
  docs: Map<string, string>,
  claims: Array<Pick<Claim, "id" | "pattern" | "floor"> & { value: number }>,
): Reconciled;
