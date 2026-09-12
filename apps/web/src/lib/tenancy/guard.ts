import { Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";
import { currentScope, describeScope, type TenancyScope } from "@/lib/tenancy/context";

// The runtime half of tenant isolation. Read lib/tenancy/context.ts first.
//
// ⚠️ THIS DOES NOT RESTATE THE STATIC SCANNER, and the split is the point —
// the same shape docs/security.md describes for the two leak scanners, where
// neither subsumes the other.
//
//   scripts/tenancy-guard.mjs  reads SOURCE and asks a question about SHAPE:
//                              does this query name a tenant at all?
//   this file                  reads ARGUMENTS and asks about VALUE:
//                              is the tenant it names the one we are serving?
//
// Neither can answer the other's question. The scanner cannot see a `where`
// assembled at runtime and has no idea what any value holds; this cannot see a
// query that never runs, and a code path exercised by nothing reports clean
// here forever. Together they cover shape-at-rest and value-in-flight.
//
// The vocabulary they share — which keys pin a row to a tenant, which
// combinators stop a key from constraining anything — is asserted equal in
// tests/tenancy/guard.test.ts rather than trusted to stay in step.

const log = logger({ surface: "tenancy-guard" });

/** Combinators whose contents do not constrain the query. A `teacherId` inside
 * an `OR` still returns every row the other branch matches; `NOT`/`none` invert
 * it. Kept identical to the scanner's set, and asserted so. */
export const NEGATING_KEYS = new Set(["OR", "NOT", "none", "isNot"]);

/** Argument keys that shape the RESULT rather than select the rows: a `where`
 * nested under `include` constrains a relation, not the root query, so a
 * tenant key found there proves nothing about what the root returns. */
const NON_FILTERING_KEYS = new Set([
  "select",
  "include",
  "omit",
  "orderBy",
  "take",
  "skip",
  "cursor",
  "distinct",
  "_count",
  "_sum",
  "_avg",
  "_min",
  "_max",
]);

// Bounded so a pathological argument object cannot turn every query into a
// deep walk. Nothing in this codebase nests filters anywhere near this far.
const MAX_DEPTH = 8;

/** Models that carry a tenant column, read from the generated datamodel rather
 * than listed here — the same rule the scanner follows, for the same reason: a
 * hand-maintained copy drifts and then silently stops guarding what it missed.
 * A new model with a `teacherId` column is covered with no edit. */
export const TENANT_MODELS: ReadonlySet<string> = new Set(
  (Prisma.dmmf?.datamodel?.models ?? [])
    .filter((m) => m.fields.some((f) => f.name === "teacherId"))
    .map((m) => m.name),
);

export class CrossTenantQueryError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly servingTeacherId: string,
    readonly namedTeacherIds: readonly string[],
  ) {
    super(
      `Cross-tenant query: ${model}.${operation} named teacher ` +
        `${namedTeacherIds.join(", ")} while serving ${servingTeacherId}. ` +
        `If this read is deliberate, wrap it in runCrossTenant("<why>", …).`,
    );
    this.name = "CrossTenantQueryError";
  }
}

export type Verdict =
  /** The query constrains itself to the tenant being served. */
  | { kind: "matches" }
  /** It constrains itself to a DIFFERENT tenant — the leak this exists for. */
  | { kind: "foreign"; named: string[] }
  /** It names no tenant. Safe or not depending on where its ids came from,
   * which is the question the scanner's baseline records and this cannot
   * answer. */
  | { kind: "none" };

/** Collect every teacher id this argument tree genuinely constrains on. */
function collectTeacherIds(node: unknown, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const el of node) collectTeacherIds(el, depth + 1, out);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (NEGATING_KEYS.has(key) || NON_FILTERING_KEYS.has(key)) continue;

    if (key === "teacherId") {
      collectFilterValues(value, out);
      continue;
    }
    // `teacher: { id }` in a filter, `teacher: { connect: { id } }` in a write.
    if (key === "teacher" && value !== null && typeof value === "object") {
      const rel = value as Record<string, unknown>;
      for (const inner of [
        rel.id,
        (rel.connect as Record<string, unknown>)?.id,
        (rel.is as Record<string, unknown>)?.id,
      ]) {
        collectFilterValues(inner, out);
      }
      continue;
    }
    collectTeacherIds(value, depth + 1, out);
  }
}

/** A tenant key's value, in the forms Prisma accepts. `undefined` is not one of
 * them: Prisma reads it as "no filter", which is the decoy the static scanner
 * exists to catch and the shape this one sees for real. */
function collectFilterValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const filter = value as Record<string, unknown>;
  if (typeof filter.equals === "string") out.push(filter.equals);
  if (Array.isArray(filter.in)) {
    for (const v of filter.in) if (typeof v === "string") out.push(v);
  }
  // `{ not: … }` / `{ notIn: … }` deliberately ignored: excluding a tenant is
  // not selecting one.
}

/** The sub-objects of a Prisma call that can carry a tenant filter. */
function filterCarriers(operation: string, args: unknown): unknown[] {
  if (args === null || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn")
    return [a.data];
  if (operation === "upsert") return [a.where, a.create];
  return [a.where];
}

/** Compare one query's arguments against the tenant being served. */
export function verdictFor(operation: string, args: unknown, servingTeacherId: string): Verdict {
  const named: string[] = [];
  for (const carrier of filterCarriers(operation, args)) collectTeacherIds(carrier, 0, named);
  if (named.length === 0) return { kind: "none" };
  if (named.includes(servingTeacherId)) return { kind: "matches" };
  return { kind: "foreign", named: [...new Set(named)] };
}

export type GuardMode = "off" | "report" | "enforce";

/**
 * How loudly the guard reacts.
 *
 * ⚠️ PRODUCTION REPORTS AND DOES NOT THROW, by default and deliberately. This
 * runs in front of every query in a system on live payment rails, and a false
 * positive here is a teacher who cannot take a booking. Share groups mean a
 * teacher-scoped request CAN legitimately touch another tenant's material, and
 * "I could not think of a case" is not evidence. So production gets a Sentry
 * error and the query it was going to run anyway, until the signal has been
 * watched and `TENANCY_GUARD=enforce` is a decision somebody takes on evidence.
 *
 * Development and test throw, because there the cost of a false positive is a
 * red test and the cost of a false negative is shipping the leak.
 *
 * Read straight from `process.env` rather than through `serverEnv()`: this
 * module is on the import path of `lib/prisma.ts`, which 65 unit-test files
 * pull in transitively with no environment at all, and `serverEnv()` throws on
 * an incomplete one. The variable is declared in `lib/env.ts` so a real boot
 * still validates it.
 */
export function guardMode(): GuardMode {
  const raw = process.env.TENANCY_GUARD;
  if (raw === "off" || raw === "report" || raw === "enforce") return raw;
  return process.env.NODE_ENV === "production" ? "report" : "enforce";
}

function report(
  verdict: Exclude<Verdict, { kind: "matches" }>,
  model: string,
  operation: string,
  scope: TenancyScope,
) {
  const fields = { model, operation, scope: describeScope(scope) };
  if (verdict.kind === "foreign") {
    // Sentry, at error level: a query naming a tenant that is not the one being
    // served is either a leak or a cross-tenant read nobody declared.
    log.error("query named a tenant other than the one being served", undefined, {
      ...fields,
      named: verdict.named.join(","),
    });
    return;
  }
  // Log only. Under a teacher scope this is the ordinary shape of the 264
  // queries the scanner baselined, and routing those to Sentry would bury the
  // line above in noise within a day.
  log.warn("query ran under a teacher scope without naming the tenant", fields);
}

/**
 * The Prisma client extension. Applied once, in `lib/prisma.ts`.
 *
 * It only ever inspects arguments and then runs the query it was given: no
 * argument is rewritten, so a bug here cannot change what the database is
 * asked for — only what gets logged, or in `enforce` whether the call happens.
 * That is a deliberate constraint on the design, not an accident of it.
 *
 * ⚠️ Raw SQL does not pass through here. `$queryRaw` carries no `where` object
 * to inspect, so it is outside this guard exactly as it is outside the static
 * one, and saying so is better than a guard that reports clean on the one shape
 * it cannot read.
 */
export function tenancyGuardExtension() {
  return Prisma.defineExtension({
    name: "tenancy-guard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const mode = guardMode();
          if (mode === "off" || !TENANT_MODELS.has(model)) return query(args);

          const scope = currentScope();
          // No gate has claimed this request. Every query looks the same from
          // here, so there is nothing to compare and nothing to say.
          if (!scope || scope.kind !== "teacher") return query(args);

          const verdict = verdictFor(operation, args, scope.teacherId);
          if (verdict.kind === "matches") return query(args);

          if (verdict.kind === "foreign" && mode === "enforce") {
            throw new CrossTenantQueryError(model, operation, scope.teacherId, verdict.named);
          }
          report(verdict, model, operation, scope);
          return query(args);
        },
      },
    },
  });
}
