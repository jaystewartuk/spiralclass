// Tenancy guardrail scanner — the mechanical half of the invariant that used
// to live only in review.
//
// There is no row-level security (D-70 retired it with Supabase). Isolation is
// the `where` clause on every query, and docs/security.md calls a missing one
// "the single largest security assumption in the system". Until this file that
// assumption was enforced by people reading diffs, which is exactly the kind
// of claim CLAUDE.md says is eventually false.
//
// So this scanner reads every Prisma call in src/ and asks, of each query
// against a tenant-owned model: **does this query actually constrain itself to
// one tenant?** It powers a RATCHET (tests/authz/tenancy-guard.test.ts)
// against a checked-in baseline, because there were 200-odd unscoped call
// sites the day it landed and a flag-day migration of all of them would have
// been a worse change than the problem. New or edited files may not add
// violations beyond their baseline; the number can only stay flat or shrink.
//
// ⚠️ IT DOES NOT CHECK THAT THE KEY IS PRESENT. It checks that the key
// CONSTRAINS — see `scopeEvidence` below. D-140's lesson was three guards that
// each certified the exact violation they existed to catch, because each one
// derived its bound from the thing it was guarding. A check for the string
// `teacherId` would be that guard: `where: { teacherId: undefined }` is a
// Prisma query with no filter at all, and `where: { OR: [{ teacherId }, …] }`
// is a query one branch of which reads every tenant. Both name the key. Both
// are the bug.
//
// Regenerate the baseline after scoping a surface (never to turn a red check
// green — that is the failure this exists to prevent):
//   node scripts/tenancy-guard.mjs --generate
//
// Report what is currently unscoped, without touching the baseline:
//   node scripts/tenancy-guard.mjs --report
import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_SRC = join(HERE, "..", "src");
export const SCHEMA_PATH = join(HERE, "..", "prisma", "schema.prisma");
export const BASELINE_PATH = join(HERE, "tenancy-guard.baseline.json");

// Prisma operations that reach the database with a caller-supplied filter.
// `findRaw`/`$queryRaw` are deliberately absent: a raw query has no `where`
// object to inspect, and pretending otherwise would be a guard that reports
// clean on the one shape it cannot read.
const READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const WRITE_OPS = new Set(["update", "updateMany", "delete", "deleteMany"]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);
const UPSERT_OPS = new Set(["upsert"]);
export const PRISMA_OPS = new Set([...READ_OPS, ...WRITE_OPS, ...CREATE_OPS, ...UPSERT_OPS]);

// The two keys that pin a row to one tenant.
//
// `teacherId` is the obvious one. `studentId` is the second axis and it is
// load-bearing rather than a convenience: a `Student` is a PER-TEACHER row
// (docs/architecture/data-model.md — a human studying with two teachers is two
// rows), so a student id already belongs to exactly one teacher and scoping by
// it is scoping by tenant. That is why the student portal's queries are safe
// without naming a teacher, and why this list is two entries and not one.
const SCOPE_KEYS = new Set(["teacherId", "studentId"]);
// The relation spellings of the same two keys, e.g. `teacher: { id }` in a
// filter or `teacher: { connect: { id } }` in a create.
const SCOPE_RELATIONS = new Set(["teacher", "student"]);

// A third, weaker kind of evidence: a foreign key to a row that is ITSELF
// tenant-owned. `where: { bookingId }` on a CallRecording reaches exactly one
// teacher's rows, because a Booking carries `teacherId` — but only if that
// booking id was itself obtained under a tenant check. This is the shape most
// of the codebase actually uses, and calling it a violation would have made
// the baseline three times larger and the check something people learn to
// stamp past. It is reported as `derived`, and the guard test holds the line
// that a `derived` query still may not become a `none` one.
//
// Derived from the schema, like everything else here: the key for a
// tenant-owned model `Booking` is `bookingId`.
function derivedScopeKeys(models) {
  return new Set([...models].map((m) => `${m}Id`));
}

// Negation can never establish a tenant. OR can do so only when every
// alternative carries the same definite tenant selector.
const NEGATING_KEYS = new Set(["NOT", "none", "isNot"]);

const EXEMPT_DIRECTIVE = /\/\/\s*tenancy-exempt:\s*(.*)$/;

/** Tenant-owned models, derived from the schema rather than listed here — a
 * hand-maintained copy would drift silently and quietly stop guarding whatever
 * it had missed. Returns the camelCase names the client exposes. */
export function tenantModels(schemaPath = SCHEMA_PATH) {
  const schema = readFileSync(schemaPath, "utf8");
  const models = new Set();
  let current = null;
  for (const line of schema.split("\n")) {
    const start = /^model\s+(\w+)\s*\{/.exec(line);
    if (start) current = start[1];
    else if (/^\}/.test(line)) current = null;
    else if (current && /^\s*teacherId\s+\S/.test(line)) {
      models.add(current[0].toLowerCase() + current.slice(1));
    }
  }
  return models;
}

/** Does this expression evaluate to something that cannot constrain a query?
 * Prisma treats `undefined` as "no filter", so a key bound to it is worse than
 * absent: it reads as scoped and behaves as unscoped. */
function isVacuous(node) {
  if (!node) return true;
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  // `x ?? undefined` and `cond ? y : undefined` are the same hazard wearing a
  // hat: both can hand Prisma an unfiltered query at runtime.
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  )
    return isVacuous(node.right);
  if (ts.isConditionalExpression(node))
    return isVacuous(node.whenTrue) || isVacuous(node.whenFalse);
  return false;
}

function propName(prop) {
  if (!prop.name) return null;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  return null;
}

function propertyValue(prop) {
  if (ts.isPropertyAssignment(prop)) return prop.initializer;
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  return null;
}

function isScalarLiteral(node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

// Only compare selectors with a statically identifiable value and no way for
// another property in the same object to override the selector.
function orBranchSelectors(branch) {
  const selectors = new Set();
  if (!ts.isObjectLiteralExpression(branch)) return selectors;
  if (branch.properties.some((prop) => !propName(prop))) return selectors;
  for (const key of SCOPE_KEYS) {
    const properties = branch.properties.filter((prop) => propName(prop) === key);
    if (properties.length !== 1) continue;
    const value = propertyValue(properties[0]);
    if (isVacuous(value)) continue;
    if (ts.isStringLiteralLike(value)) selectors.add(`${key}:string:${value.text}`);
    else if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
      selectors.add(`${key}:expression:${value.getText()}`);
    }
  }
  return selectors;
}

function orEvidence(value, negated, derived) {
  if (ts.isArrayLiteralExpression(value) && !negated && value.elements.length > 0) {
    const branches = value.elements.map(orBranchSelectors);
    if ([...branches[0]].some((selector) => branches.every((branch) => branch.has(selector)))) {
      return "scoped";
    }
  }
  return scopeEvidence(value, true, derived);
}

/**
 * Walk a `where` / `data` object and report the strongest scope evidence in it.
 *
 * Returns one of:
 *   "scoped"    — a tenant key constrains the query
 *   "vacuous"   — a tenant key is present but bound to undefined/null
 *   "negated"   — a tenant key is present only inside OR/NOT/none
 *   "opaque"    — the object cannot be read statically (spread, identifier…)
 *   "none"      — no tenant key anywhere
 *
 * `negated` and `vacuous` are reported separately from `none` on purpose: they
 * are the two shapes that LOOK scoped to a reader and to `grep`, and they are
 * the reason this scanner parses instead of matching text.
 */
export function scopeEvidence(node, negated = false, derived = defaultDerivedKeys()) {
  if (!node || isScalarLiteral(node)) return "none";
  // `where: someVariable` — no way to know, so say so rather than assume.
  if (!ts.isObjectLiteralExpression(node)) {
    return ts.isArrayLiteralExpression(node)
      ? mergeEvidence(node.elements.map((el) => scopeEvidence(el, negated, derived)))
      : "opaque";
  }

  const found = [];
  for (const prop of node.properties) {
    // `...rest` hides arbitrary keys, including the scope — and including its
    // absence.
    if (ts.isSpreadAssignment(prop)) {
      found.push("opaque");
      continue;
    }
    const name = propName(prop);
    if (!name) continue;

    const value = propertyValue(prop);

    if (name === "OR" && value) {
      found.push(orEvidence(value, negated, derived));
      continue;
    }

    if (SCOPE_KEYS.has(name)) {
      if (isVacuous(value)) found.push("vacuous");
      else if (negated) found.push("negated");
      // `teacherId: { not: x }` names the key and excludes one tenant rather
      // than selecting one, which is the OR problem in miniature.
      else if (value && ts.isObjectLiteralExpression(value) && hasOnlyNegatingFilter(value))
        found.push("negated");
      else found.push("scoped");
      continue;
    }

    if (derived.has(name)) {
      if (isVacuous(value)) found.push("vacuous");
      else if (negated) found.push("negated");
      else found.push("derived");
      continue;
    }

    if (SCOPE_RELATIONS.has(name) && value) {
      found.push(relationEvidence(value, negated));
      continue;
    }

    if (value && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) {
      found.push(scopeEvidence(value, negated || NEGATING_KEYS.has(name), derived));
    }
  }
  return mergeEvidence(found);
}

let derivedCache = null;
function defaultDerivedKeys() {
  derivedCache ??= derivedScopeKeys(tenantModels());
  return derivedCache;
}

/** `{ not: … }` / `{ notIn: … }` select everything except a tenant. */
function hasOnlyNegatingFilter(obj) {
  const names = obj.properties.map(propName).filter(Boolean);
  return names.length > 0 && names.every((n) => n === "not" || n === "notIn");
}

/** `teacher: { id }`, `student: { connect: { id } }`, `teacher: { is: { id } }`. */
function relationEvidence(value, negated) {
  if (!ts.isObjectLiteralExpression(value)) return "opaque";
  const found = [];
  for (const prop of value.properties) {
    if (ts.isSpreadAssignment(prop)) {
      found.push("opaque");
      continue;
    }
    const name = propName(prop);
    if (!name) continue;
    const inner = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : ts.isShorthandPropertyAssignment(prop)
        ? prop.name
        : null;
    if (name === "id") found.push(isVacuous(inner) ? "vacuous" : negated ? "negated" : "scoped");
    else if (name === "connect" || name === "is" || name === "some" || name === "every")
      found.push(relationEvidence(inner, negated));
    else if (name === "none" || name === "isNot") found.push(relationEvidence(inner, true));
  }
  return mergeEvidence(found);
}

// Strongest wins: one genuinely constraining key makes the query safe however
// much else is in the object. That is sound rather than optimistic — Prisma
// ANDs the keys of a `where`, so an unreadable spread beside a readable
// `teacherId` can only narrow what the tenant key already selected.
//
// "opaque" outranks the two look-alikes only because an unreadable object
// might contain the real thing; all three are violations.
const RANK = ["none", "vacuous", "negated", "opaque", "derived", "scoped"];
const ACCEPTED = new Set(["scoped", "derived"]);
function mergeEvidence(list) {
  let best = "none";
  for (const e of list) if (RANK.indexOf(e) > RANK.indexOf(best)) best = e;
  return best;
}

function mappedRow(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.questionDotToken || node.expression.questionDotToken) return null;
  if (node.expression.name.text !== "map") return null;
  const callback = node.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) return null;
  let returned = callback.body;
  if (ts.isBlock(returned)) {
    const onlyStatement = returned.statements.length === 1 && returned.statements[0];
    if (!onlyStatement || !ts.isReturnStatement(onlyStatement)) return null;
    returned = onlyStatement.expression;
  }
  while (returned && ts.isParenthesizedExpression(returned)) returned = returned.expression;
  if (!returned || !ts.isObjectLiteralExpression(returned)) return null;
  const names = returned.properties.map(propName);
  if (names.includes(null) || new Set(names).size !== names.length) return null;
  return returned;
}

function manyCreateEvidence(data, derived) {
  if (!data) return "none";
  if (ts.isArrayLiteralExpression(data)) {
    const rows = data.elements.map((row) => scopeEvidence(row, false, derived));
    const unreadable = rows.filter((evidence) => !ACCEPTED.has(evidence));
    return mergeEvidence(unreadable.length > 0 ? unreadable : rows);
  }
  return scopeEvidence(mappedRow(data) ?? data, false, derived);
}

function queryEvidence(op, args, derived) {
  if (!args) return "none";
  if (!ts.isObjectLiteralExpression(args)) return "opaque";
  const field = CREATE_OPS.has(op) ? "data" : "where";
  const property = args.properties.find((prop) => propName(prop) === field);
  const carrier = property ? propertyValue(property) : null;
  if (op === "createMany" || op === "createManyAndReturn") {
    return manyCreateEvidence(carrier, derived);
  }
  // For upsert, the insert cannot constrain the lookup that drives the update.
  return scopeEvidence(carrier, false, derived);
}

function exemptionFor(lines, lineIndex) {
  for (let i = lineIndex; i >= 0; i--) {
    if (i !== lineIndex && !lines[i].trimStart().startsWith("//")) break;
    const match = EXEMPT_DIRECTIVE.exec(lines[i]);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Findings for one source file: every query against a tenant-owned model that
 * does not constrain itself to a tenant.
 *
 * @returns {{violations: Array, exemptions: Array}}
 */
export function scanSource(fileName, source, models = tenantModels()) {
  const derived = derivedScopeKeys(models);
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const violations = [];
  const exemptions = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const op = node.expression.name.text;
      const model = node.expression.expression.name.text;
      // Payment has no teacherId of its own. Its required Package relation
      // establishes ownership without adding a new generic derived scope key.
      const tenantOwned = models.has(model) || (model === "payment" && models.has("package"));
      if (PRISMA_OPS.has(op) && tenantOwned) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const evidence = queryEvidence(op, node.arguments[0], derived);

        if (!ACCEPTED.has(evidence)) {
          const reason = exemptionFor(lines, line);
          const finding = { line: line + 1, model, op, evidence };
          if (reason !== null) exemptions.push({ ...finding, reason });
          else violations.push(finding);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, exemptions };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const rel = (srcDir, file) => relative(srcDir, file).split(sep).join("/");

/** Every unscoped query in the tree, grouped by file. */
export function collectFindings(srcDir = WEB_SRC, models = tenantModels()) {
  const byFile = {};
  const exemptions = [];
  for (const file of walk(srcDir)) {
    const result = scanSource(file, readFileSync(file, "utf8"), models);
    const path = rel(srcDir, file);
    if (result.violations.length > 0) byFile[path] = result.violations;
    for (const e of result.exemptions) exemptions.push({ file: path, ...e });
  }
  return { byFile, exemptions };
}

/** Map of src-relative path → unscoped-query count, for the ratchet. */
export function collectCounts(srcDir = WEB_SRC, models = tenantModels()) {
  const { byFile } = collectFindings(srcDir, models);
  return Object.fromEntries(Object.entries(byFile).map(([file, v]) => [file, v.length]));
}

export function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

if (process.argv.includes("--generate") || process.argv.includes("--report")) {
  const models = tenantModels();
  const { byFile, exemptions } = collectFindings(WEB_SRC, models);
  const counts = Object.fromEntries(
    Object.entries(byFile)
      .map(([file, v]) => [file, v.length])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (process.argv.includes("--report")) {
    const tally = {};
    for (const list of Object.values(byFile))
      for (const v of list) tally[v.evidence] = (tally[v.evidence] ?? 0) + 1;
    for (const [file, list] of Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)))
      for (const v of list) console.log(`${file}:${v.line}  ${v.model}.${v.op}  [${v.evidence}]`);
    console.log(`\n${total} unscoped queries in ${Object.keys(counts).length} files.`);
    console.log(`By evidence: ${JSON.stringify(tally)}`);
    console.log(`${exemptions.length} exempted call sites.`);
  } else {
    writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + "\n");
    console.log(`Wrote baseline: ${Object.keys(counts).length} files, ${total} unscoped queries.`);
  }
}
