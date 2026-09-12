import { AsyncLocalStorage } from "node:async_hooks";

// Who this request is being served for, carried beside the call stack rather
// than threaded through every function that might reach the database.
//
// This exists because of a gap the static guard cannot close. `tenancy-guard`
// (scripts/, D-175) proves a query NAMES a tenant; it cannot prove the tenant
// it names is the one whose page is being rendered. Passing an attacker's
// `teacherId` into a perfectly-scoped `where` is a query that satisfies every
// static check in the repository and returns somebody else's rows.
//
// The tenant a request is entitled to is known exactly once — at the auth
// gate — and nowhere after it. So the gate records it here, and
// `lib/tenancy/guard.ts` compares every query against it.
//
// ⚠️ IT IS ALSO THE SEAT FOR ROW-LEVEL SECURITY. If Postgres RLS ever lands,
// the tenant has to reach the database as `SET LOCAL app.tenant_id` inside the
// same transaction as the query — Neon's pooled endpoint is transaction-mode
// and a session-level `SET` would leak into whichever request borrows that
// connection next (see lib/db-pool.ts). This module is where that value would
// come from, which is why it is a context rather than a parameter.

export type TenancyScope =
  | { readonly kind: "teacher"; readonly teacherId: string }
  // A read that crosses tenants on purpose: the admin console (D-25), a
  // webhook resolving which teacher an external id belongs to, a background
  // job sweeping every tenant. The reason is carried so a report says which.
  | { readonly kind: "cross-tenant"; readonly reason: string };

const storage = new AsyncLocalStorage<TenancyScope>();

/** The scope this request is running under, or undefined if nothing set one. */
export function currentScope(): TenancyScope | undefined {
  return storage.getStore();
}

/**
 * Bind the rest of this request to one teacher.
 *
 * ⚠️ `enterWith`, not `run`, and the difference is why this is callable from an
 * auth gate at all. A gate RETURNS a teacher; it does not wrap the page that
 * called it, so there is no callback to hand `run` — the work that must inherit
 * the scope has not been written yet when the gate finishes. `enterWith` binds
 * the current execution context and everything that descends from it, which is
 * exactly the shape of "everything this request does from here on".
 *
 * `tests/tenancy/context.test.ts` proves that propagation across an await
 * chain rather than assuming it: a scope that silently failed to propagate
 * would leave the guard reporting every query as unattributed, which reads
 * identically to a clean tree.
 *
 * The lazy-promise trap described on `runInTeacherScope` does not apply here,
 * and the reason is the whole point of using `enterWith`: there is no callback
 * to fall out of. The binding stays on the request's execution context, so a
 * query awaited anywhere downstream of the gate still sees it.
 */
export function enterTeacherScope(teacherId: string): void {
  storage.enterWith({ kind: "teacher", teacherId });
}

/**
 * Run `fn` bound to one teacher. The right call when there IS a callback to
 * wrap — a job that iterates tenants, say.
 *
 * ⚠️ `fn` MUST RETURN A PROMISE, AND THIS AWAITS IT INSIDE THE SCOPE. That is
 * not ceremony: a Prisma query is a lazy `PrismaPromise` that does nothing
 * until it is awaited, so
 *
 *     runInTeacherScope(id, () => prisma.booking.findMany(…))   // ← the trap
 *
 * would exit the scope the instant it returned the unawaited promise, and the
 * query would then execute with NO SCOPE AT ALL. The guard would wave it
 * through and report a tenant-scoped request as unattributed — a silent hole
 * that looks exactly like a clean system. Awaiting here rather than leaving it
 * to the caller means the shape above is correct instead of quietly wrong.
 * `tests/tenancy/interception.test.ts` holds this.
 */
export async function runInTeacherScope<T>(
  teacherId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return storage.run({ kind: "teacher", teacherId }, async () => await fn());
}

/**
 * Run `fn` as a deliberate cross-tenant read.
 *
 * Say why in `reason` — it is what a report shows and what a reviewer reads.
 * This is the runtime twin of the `// tenancy-exempt:` directive the static
 * scanner takes, and it exists for the same reason: a cross-tenant query is
 * fine when somebody signed for it and indefensible when nobody did.
 */
export async function runCrossTenant<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
  return storage.run({ kind: "cross-tenant", reason }, async () => await fn());
}

/** Describe the active scope for a log line. */
export function describeScope(scope: TenancyScope | undefined): string {
  if (!scope) return "unscoped";
  return scope.kind === "teacher" ? `teacher:${scope.teacherId}` : `cross-tenant:${scope.reason}`;
}
