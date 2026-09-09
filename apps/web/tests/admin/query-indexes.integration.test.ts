import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// Admin/finance routes are the one place that queries Prisma models
// cross-tenant (every other request-path query is teacherId-scoped and
// RLS-enforced — see CLAUDE.md's tenancy model). The composite indexes
// added in the `add_admin_query_indexes` migration cover the where+orderBy
// shapes those routes actually use (e.g. /admin/payments and
// /api/admin/export/payments: filter by status, sort by createdAt).
//
// It asserts the PLANNER's choice, which means it has to give the planner the
// three things a planner needs, and for most of its life it gave none of them.
//
// REWRITTEN 2026-09-01, after it failed on merged `main` and blocked a release
// that had nothing to do with payments. Each of its three premises was wrong:
//
//   1. "the planner falls back to a Seq Scan (the ONLY remaining option)" — it
//      is not. `payments` carries three other status-prefixed indexes
//      (`payments_status_idx`, `payments_status_paid_at_idx`, and the partial
//      `payment_pending_per_package_uidx`), so coercing seqscan off leaves
//      several alternatives. The planner picked `payments_status_paid_at_idx`
//      and the test read that as a missing index.
//   2. It never ANALYZEd. `truncateAll()` discards statistics, so the planner
//      was costing a ONE-row table at its default estimate of 210 rows —
//      whether it happened to be right depended on autovacuum timing, on a
//      database several worktrees truncate all day.
//   3. It omitted the LIMIT, while claiming to use the "same where+orderBy
//      shape" as the route. That omission is the whole point: a composite
//      (status, created_at) index earns its keep by letting a PAGINATED query
//      stop early. Without a LIMIT, sorting the matches really is cheaper, and
//      the planner was right to say so.
//
// So it now seeds realistic volume, ANALYZEs, and runs the query the route
// actually runs — including `LIMIT PAGE_SIZE`. The coercion is gone: with
// facts and a realistic shape the index wins on merit, which is a stronger
// claim than "wins once its rivals are disabled". Verified in both directions
// before landing: the plan is an Index Scan Backward on the expected index,
// and dropping that index turns it into Sort + Seq Scan.

const TEACHER_ID = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const STUDENT_EMAIL = "alumno-idx@e2e.test";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

type PlanNode = {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};

function findNode(node: PlanNode, match: (n: PlanNode) => boolean): boolean {
  if (match(node)) return true;
  return (node.Plans ?? []).some((child) => findNode(child, match));
}

function findIndexScan(node: PlanNode, indexName: string): boolean {
  return findNode(
    node,
    (n) =>
      (n["Node Type"] === "Index Scan" || n["Node Type"] === "Index Only Scan") &&
      n["Index Name"] === indexName,
  );
}

/** The composite index's actual job is to supply the ORDER, so a plan using it
 * properly needs no Sort at all. Asserting the index name alone would still
 * pass if the planner used it for the filter and then sorted anyway — which is
 * the expensive shape the index exists to remove. */
function hasSort(node: PlanNode): boolean {
  return findNode(node, (n) => n["Node Type"] === "Sort");
}

/** apps/web/src/app/admin/payments/page.tsx. Mirrored rather than imported:
 * that page is a server component pulling in Prisma, auth and the whole admin
 * shell, and this file needs only the number. */
const PAGE_SIZE = 100;

/** Enough rows that the planner has a real decision to make. At a handful of
 * rows every plan costs about nothing and the choice between them is
 * arbitrary — which is how this test used to pass or fail on luck. */
const SEEDED_PAYMENTS = 2_000;

describeIntegration("admin query indexes (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("uses payments_status_created_at_idx for the admin payments status+createdAt query", async () => {
    const prisma = getTestPrisma();
    await ensureAuthUser(TEACHER_ID, "teacher-idx@e2e.test");
    const teacher = await prisma.teacher.create({
      data: {
        id: TEACHER_ID,
        email: "teacher-idx@e2e.test",
        name: "Alicia Moreno",
        timezone: "America/Mexico_City",
        bookingSlug: "teacher-idx",
      },
      select: { id: true },
    });
    const student = await prisma.student.create({
      data: { email: STUDENT_EMAIL, name: "Alumno", locale: "es-MX" },
      select: { id: true },
    });
    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });
    const pkg = await prisma.package.create({
      data: {
        teacherId: teacher.id,
        studentId: student.id,
        classesTotal: 10,
        classesUsed: 0,
        classDurationMin: 50,
        pricePaidMinorUnits: 150_000,
        purchasedAt: new Date(),
        status: "active",
      },
      select: { id: true },
    });
    // Half paid, half refunded, spread over distinct created_at values — the
    // shape the admin list actually pages through. `pending` is deliberately
    // absent: `payment_pending_per_package_uidx` is a partial unique index on
    // (package_id) WHERE status = 'pending', so a second pending row on one
    // package cannot exist.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "payments" (package_id, amount_minor_units, status, provider, paid_at, created_at)
       SELECT $1::uuid, 150000,
              (ARRAY['paid','refunded'])[1 + (i % 2)]::"PaymentStatus",
              'stripe', now(), now() - (i || ' minutes')::interval
       FROM generate_series(1, $2::int) i`,
      pkg.id,
      SEEDED_PAYMENTS,
    );

    // Without this the planner costs the table at its default estimate (210
    // rows) rather than what is actually there, and picks accordingly.
    // `truncateAll()` in beforeEach discards statistics, so this cannot be
    // left to autovacuum.
    await prisma.$executeRawUnsafe(`ANALYZE "payments"`);

    // The query the route actually runs — where, orderBy AND the page limit
    // (apps/web/src/app/admin/payments/page.tsx; the export route at
    // api/admin/export/payments shares the where+orderBy). The LIMIT is the
    // part that matters: it is what lets an ordered index scan stop early,
    // and it is why this index exists.
    //
    // No `enable_seqscan = off`. The planner is left free, so a pass means the
    // index is genuinely the cheapest way to answer this — not merely the
    // cheapest once its alternatives were switched off.
    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (FORMAT JSON) SELECT * FROM "payments" WHERE "status" = 'paid' ORDER BY "created_at" DESC LIMIT ${PAGE_SIZE}`,
    );
    const rootPlan = (plan[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan;

    expect(
      findIndexScan(rootPlan, "payments_status_created_at_idx"),
      `admin payments query no longer uses its index:\n${JSON.stringify(rootPlan, null, 2)}`,
    ).toBe(true);
    expect(
      hasSort(rootPlan),
      "the index is supplying the filter but not the order — a Sort means the composite index is not earning its keep",
    ).toBe(false);
  });
});
