import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The scanner lives in scripts/ (plain ESM, outside src/) so it stays out of
// the coverage denominator; the test drives it here — the same shape as
// tests/i18n-guard.test.ts.
import {
  collectFindings,
  loadBaseline,
  scanSource,
  SCHEMA_PATH,
  tenantModels,
} from "../../scripts/tenancy-guard.mjs";

// Ratchet guard for the invariant docs/security.md calls the single largest
// security assumption in the system: there is no row-level security, so a
// query against a tenant-owned model that does not constrain itself to one
// tenant is a cross-tenant read waiting for a caller to supply the wrong id.
//
// Until this test that was enforced by people reading diffs. It is now
// enforced by the fast tier on every push. Existing offenders are recorded in
// scripts/tenancy-guard.baseline.json; the count may shrink and may not grow.
//
//   node scripts/tenancy-guard.mjs --report     what is unscoped today
//   node scripts/tenancy-guard.mjs --generate   after scoping a surface
describe("tenancy scoping ratchet", () => {
  const models = tenantModels();
  const baseline: Record<string, number> = loadBaseline();
  // ONE walk of the tree, shared by every assertion below. Parsing every file
  // in src/ is the expensive part, and doing it twice — once for the counts,
  // again for the exemptions — pushed a single test past the 20s timeout on a
  // two-core runner under coverage instrumentation, having passed on the
  // previous push. A guard that flakes is a guard people learn to re-run.
  const findings = collectFindings(undefined, models);
  const current: Record<string, number> = Object.fromEntries(
    Object.entries(findings.byFile).map(([file, list]) => [file, list.length]),
  );

  it("adds no new files containing unscoped tenant queries", () => {
    const newOffenders = Object.keys(current).filter((file) => !(file in baseline));
    expect(
      newOffenders,
      `New unscoped queries against tenant-owned models. Add the tenant to the ` +
        `where clause (\`where: { id, teacherId }\` is valid on update/delete), or ` +
        `mark the call site \`// tenancy-exempt: <why this reads across tenants>\`:\n` +
        newOffenders.join("\n"),
    ).toEqual([]);
  });

  it("does not increase the count in any baselined file", () => {
    const regressions = Object.keys(current)
      .filter((file) => file in baseline && current[file] > baseline[file])
      .map((file) => `${file}: ${baseline[file]} → ${current[file]}`);
    expect(
      regressions,
      `Files added unscoped tenant queries beyond their baseline:\n${regressions.join("\n")}`,
    ).toEqual([]);
  });

  it("holds the baseline itself to the tree", () => {
    // A baseline entry for a file that no longer exists is a guard whose
    // premise has died — the thing CLAUDE.md says to retire in the same change
    // as its subject. Stale entries also silently raise the ceiling for a file
    // recreated at the same path later.
    const stale = Object.keys(baseline).filter((file) => !(file in current));
    expect(
      stale,
      `Baselined files are now clean or gone. Regenerate:\n` +
        `  node scripts/tenancy-guard.mjs --generate\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  // ── The anti-tautology half ────────────────────────────────────────────
  //
  // D-140's lesson: three guards each certified the exact violation they
  // existed to catch, because each derived its bound from the thing it was
  // guarding. Everything above this line would pass just as happily if the
  // scanner had quietly stopped finding anything. These assertions are the
  // external ground truth that says it still works.

  it("derives a substantial tenant-model list from the schema", () => {
    // If this ever returns an empty set — a schema reformat, a Prisma syntax
    // change — every assertion above passes vacuously and the ratchet goes
    // green forever. So assert the derivation still bites.
    expect(models.size).toBeGreaterThan(50);
    for (const model of ["booking", "package", "teacherStudent", "message", "lead"]) {
      expect(models, `${model} carries teacherId in schema.prisma`).toContain(model);
    }
    expect(models, "student is scoped through TeacherStudent, not by a column").not.toContain(
      "student",
    );
  });

  it("accepts a query that genuinely constrains itself to one tenant", () => {
    const scoped = [
      `prisma.booking.findMany({ where: { teacherId } })`,
      `prisma.booking.findMany({ where: { AND: [{ teacherId }, { status: "x" }] } })`,
      `prisma.booking.findFirst({ where: { teacher: { id: t } } })`,
      `prisma.package.findMany({ where: { studentId } })`,
      `prisma.booking.update({ where: { id, teacherId }, data: {} })`,
      `prisma.booking.create({ data: { teacher: { connect: { id } } } })`,
      // A spread beside a real tenant key is safe: Prisma ANDs the keys of a
      // where, so whatever the spread adds can only narrow the tenant's rows.
      `prisma.booking.findMany({ where: { teacherId, ...rest } })`,
      // A foreign key to a row that is itself tenant-owned.
      `prisma.callRecording.findFirst({ where: { bookingId } })`,
    ];
    for (const src of scoped) {
      expect(scanSource("t.ts", src, models).violations, src).toEqual([]);
    }
  });

  it("rejects the shapes that name the tenant key without constraining on it", () => {
    // Every one of these contains the string `teacherId`. A grep-shaped check
    // would pass all five, which is exactly why the scanner parses.
    const decoys: Array<[string, string]> = [
      // Prisma reads `undefined` as "no filter" — worse than absent, because
      // it reads as scoped.
      [`prisma.booking.findMany({ where: { teacherId: undefined } })`, "vacuous"],
      [`prisma.booking.findMany({ where: { teacherId: null } })`, "vacuous"],
      [`prisma.booking.findMany({ where: { teacherId: t ?? undefined } })`, "vacuous"],
      // One branch of an OR still returns every row the other branch matches.
      [`prisma.booking.findMany({ where: { OR: [{ teacherId }, { x: 1 }] } })`, "negated"],
      // Selects every tenant except one.
      [`prisma.booking.findMany({ where: { teacherId: { not: t } } })`, "negated"],
    ];
    for (const [src, evidence] of decoys) {
      const { violations } = scanSource("t.ts", src, models);
      expect(violations.length, src).toBe(1);
      expect(violations[0].evidence, src).toBe(evidence);
    }
  });

  it("refuses to guess at a where clause it cannot read", () => {
    for (const src of [
      `prisma.booking.findMany({ where })`,
      `prisma.booking.findMany({ where: { ...filters } })`,
      `prisma.booking.findMany(buildQuery(input))`,
    ]) {
      const { violations } = scanSource("t.ts", src, models);
      expect(violations.length, src).toBe(1);
      expect(violations[0].evidence, src).toBe("opaque");
    }
    // …and an unfiltered read is the plain case.
    expect(scanSource("t.ts", `prisma.booking.findMany()`, models).violations[0].evidence).toBe(
      "none",
    );
  });

  it("reads an exemption directive and the reason attached to it", () => {
    const { violations, exemptions } = scanSource(
      "t.ts",
      `// tenancy-exempt: admin console reads every tenant by design (D-25)\n` +
        `prisma.booking.findMany({});\n`,
      models,
    );
    expect(violations).toEqual([]);
    expect(exemptions.length).toBe(1);
    expect(exemptions[0].reason).toContain("D-25");
  });

  it("guards payment rows through the package that owns them", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const payment = /^model Payment\s*\{([\s\S]*?)^\}/m.exec(schema)?.[1];
    expect(payment).toMatch(/^\s*packageId\s+String\s/m);
    expect(payment).toMatch(
      /^\s*package\s+Package\s+@relation\(fields: \[packageId\], references: \[id\]/m,
    );
    expect(scanSource("t.ts", "prisma.payment.findMany({})", models).violations).toEqual([
      expect.objectContaining({ model: "payment", op: "findMany", evidence: "none" }),
    ]);
    for (const src of [
      "prisma.payment.findMany({ where: { packageId } })",
      "prisma.payment.findMany({ where: { package: { teacherId } } })",
    ]) {
      expect(scanSource("t.ts", src, models).violations, src).toEqual([]);
    }
  });

  it("checks the upsert match even when the insert carries the teacher", () => {
    const upsert = (where: string) =>
      `prisma.booking.upsert({ where: ${where}, create: { teacherId }, update: {} })`;
    expect(scanSource("t.ts", upsert("{ id }"), models).violations).toHaveLength(1);
    expect(scanSource("t.ts", upsert("{ id, teacherId }"), models).violations).toEqual([]);
  });

  it("checks every readable createMany row and recognizes inline map callbacks", () => {
    for (const rows of [
      "items.map(({ name }) => ({ name, teacherId }))",
      "items.map((item) => { return { item, teacherId }; })",
      "[{ teacherId }, { teacherId }]",
    ]) {
      const src = `prisma.booking.createMany({ data: ${rows} })`;
      expect(scanSource("t.ts", src, models).violations, src).toEqual([]);
    }
    for (const rows of [
      "items.map(makeRow)",
      "items.map((item) => ({ item }))",
      "items.map((item) => ({ teacherId, ...item }))",
      "items.map((item) => item.good ? { teacherId } : { item })",
      "[{ teacherId }, {}]",
    ]) {
      const src = `prisma.booking.createManyAndReturn({ data: ${rows} })`;
      expect(scanSource("t.ts", src, models).violations, src).toHaveLength(1);
    }
  });

  it("reads scalar value lists without crediting them as tenant evidence", () => {
    const filter = "action: { in: ['create', 'update'] }";
    expect(
      scanSource("t.ts", `prisma.booking.findMany({ where: { teacherId, ${filter} } })`, models)
        .violations,
    ).toEqual([]);
    expect(
      scanSource("t.ts", `prisma.booking.findMany({ where: { ${filter} } })`, models).violations[0]
        .evidence,
    ).toBe("none");
  });

  it("requires OR branches to share a definite tenant selector", () => {
    const query = (branches: string) => `prisma.booking.findMany({ where: { OR: ${branches} } })`;
    expect(
      scanSource("t.ts", query("[{ teacherId, status: 'a' }, { teacherId, status: 'b' }]"), models)
        .violations,
    ).toEqual([]);
    for (const branches of [
      "[{ teacherId }, { studentId }]",
      "[{ teacherId: 'a' }, { teacherId: 'b' }]",
      "[{ teacherId }, { teacherId: undefined }]",
      "[{ teacherId }, { teacherId: { not: teacherId } }]",
      "[{ teacherId }, { teacherId, ...unsafeOverrides }]",
      "[{ teacherId }, {}]",
      "pairs",
    ]) {
      expect(scanSource("t.ts", query(branches), models).violations, branches).toHaveLength(1);
    }
  });

  it("attaches multiline exemption comments to the immediately following call only", () => {
    const source = [
      "// tenancy-exempt: operator reads all tenants",
      "// This second line explains why.",
      "// This third line gives context.",
      "prisma.booking.findMany({});",
      "prisma.booking.findMany({});",
    ].join("\n");
    const { exemptions, violations } = scanSource("t.ts", source, models);
    expect(exemptions.map((entry) => entry.line)).toEqual([4]);
    expect(violations.map((entry) => entry.line)).toEqual([5]);

    const separated = [
      "// tenancy-exempt: operator reads all tenants",
      "doSomethingElse();",
      "prisma.booking.findMany({});",
    ].join("\n");
    expect(scanSource("t.ts", separated, models).violations).toHaveLength(1);
  });

  it("requires every exemption in the tree to say why it reads across tenants", () => {
    // An exemption is a cross-tenant query somebody signed for. A bare
    // `// tenancy-exempt:` is a silencer, and a check that can be silenced
    // without a reason stops being a check — so an empty or one-word reason
    // fails here rather than being counted.
    const { exemptions } = findings;
    const unjustified = exemptions
      .filter((e) => e.reason.trim().split(/\s+/).filter(Boolean).length < 4)
      .map((e) => `${e.file}:${e.line} ${e.model}.${e.op} — "${e.reason}"`);
    expect(
      unjustified,
      `tenancy-exempt needs a reason a reviewer can check:\n${unjustified.join("\n")}`,
    ).toEqual([]);
  });
});
