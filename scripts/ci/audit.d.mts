// Types for the dependency-audit wrapper (scripts/ci/audit.mjs). Kept as a
// sibling declaration for the same reason steps.d.mts is: the module stays a
// plain runnable .mjs — the gate spawns it as `node scripts/ci/audit.mjs` with
// no build step — while the guard test
// (apps/web/tests/config/audit-step.test.ts) imports its classifiers with full
// types.

/**
 * True when the advisory database answered, whatever else went wrong on the way
 * there. A printed vulnerability count is the tell.
 */
export function reachedTheDatabase(output: string): boolean;

/**
 * True when the failure is about the network rather than about this tree's
 * dependencies — a timeout, a refused connection, a 5xx from the registry.
 */
export function isTransportFailure(output: string): boolean;

/**
 * What to do with a non-zero `pnpm audit`.
 *
 * `"fail"` for findings, for an unrecognised error, and — importantly — for
 * output that carries both a retried timeout and a real count, so one flaky
 * request cannot launder a genuine finding into a skip. `"skip"` only when the
 * database was never reached.
 */
export function verdictFor(output: string): "fail" | "skip";
