// UAT DB cross-check — read-only. Runs the same purchase/refund/subscription
// assertions as /admin/uat's runbook (student purchase, refund, teacher
// subscription upgrade) and prints PASS/FAIL per field, so the operator reads
// a verdict instead of hand-running SQL and eyeballing rows. Read-only (plain
// SELECTs via Prisma) — safe to point at preview or, post-promote, prod.
//
// Usage (defaults to preview via the pnpm script's dotenv env):
//   pnpm uat:verify --student you+stripe-uat@example.com      # §B7 purchase
//   pnpm uat:verify --payment <payment-uuid>                   # §G5 refund
//   pnpm uat:verify --teacher <teacher-email-or-uuid>          # §N4 upgrade
//   pnpm uat:verify --student <email> --payment <id> --teacher <email>
//
// Exit 0 only if every requested check passes.

import { PrismaClient } from "@prisma/client";

import { pgAdapter } from "@/lib/db-pool";

const uatUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!uatUrl) throw new Error("Neither DIRECT_URL nor DATABASE_URL is set.");
const prisma = new PrismaClient({ adapter: pgAdapter(uatUrl) });

// --- tiny assertion harness -------------------------------------------------
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`\x1b[32mPASS\x1b[0m  ${label.padEnd(22)} ${detail}`);
  } else {
    console.log(`\x1b[31mFAIL\x1b[0m  ${label.padEnd(22)} ${detail}`);
    failures += 1;
  }
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error(`Flag --${key} needs a value`);
      }
      out[key] = val;
      i += 1;
    }
  }
  return out;
}

// --- §B7: student's latest payment is a settled card charge, package active ---
async function verifyStudentPurchase(email: string): Promise<void> {
  console.log(`\n§B7 student purchase — ${email}`);
  const student = await prisma.student.findFirst({
    where: { email },
    select: { id: true },
  });
  if (!student) {
    check("student-exists", false, `no student with email ${email}`);
    return;
  }
  const payment = await prisma.payment.findFirst({
    where: { package: { studentId: student.id } },
    orderBy: { createdAt: "desc" },
    include: { package: { select: { status: true } } },
  });
  if (!payment) {
    check("payment-exists", false, "student has no payments");
    return;
  }
  check("payment.status", payment.status === "paid", `= ${payment.status} (want paid)`);
  check("payment.rail", payment.rail === "card", `= ${payment.rail} (want card)`);
  // No transfer check: under direct charges (D-143) the money settles on the
  // teacher's own connected account and the platform creates no Transfer. The
  // payment being `paid` with rail `card` is the whole card-rail assertion now.
  check(
    "package.status",
    payment.package.status === "active",
    `= ${payment.package.status} (want active)`,
  );
}

// --- §G5: a specific payment is refunded and its package is refunded ---
async function verifyRefund(paymentId: string): Promise<void> {
  console.log(`\n§G5 refund — payment ${paymentId}`);
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { package: { select: { status: true } } },
  });
  if (!payment) {
    check("payment-exists", false, `no payment with id ${paymentId}`);
    return;
  }
  check("payment.status", payment.status === "refunded", `= ${payment.status} (want refunded)`);
  check("payment.refunded_at", payment.refundedAt != null, `= ${payment.refundedAt ?? "<null>"}`);
  check(
    "package.status",
    payment.package.status === "refunded",
    `= ${payment.package.status} (want refunded)`,
  );
}

// --- §N4: teacher subscription upgraded to a paid plan, active ---
async function verifySubscription(teacherRef: string): Promise<void> {
  console.log(`\n§N4 subscription upgrade — ${teacherRef}`);
  const teacher = await prisma.teacher.findFirst({
    where: teacherRef.includes("@") ? { email: teacherRef } : { id: teacherRef },
    select: { id: true, email: true },
  });
  if (!teacher) {
    check("teacher-exists", false, `no teacher matching ${teacherRef}`);
    return;
  }
  const sub = await prisma.teacherSubscription.findUnique({
    where: { teacherId: teacher.id },
  });
  if (!sub) {
    check("subscription-exists", false, `teacher ${teacher.email} has no subscription row`);
    return;
  }
  check(
    "subscription.plan",
    sub.plan === "monthly" || sub.plan === "annual",
    `= ${sub.plan} (want monthly|annual)`,
  );
  check("subscription.status", sub.status === "active", `= ${sub.status} (want active)`);
  check(
    "subscription.stripe_id",
    !!sub.stripeSubscriptionId,
    `= ${sub.stripeSubscriptionId ?? "<null>"}`,
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.student && !flags.payment && !flags.teacher) {
    console.error(
      "Nothing to check. Pass at least one of --student <email> / --payment <id> / --teacher <email|id>.",
    );
    process.exit(2);
  }
  console.log(`→ verifying against ${process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL"}`);
  if (flags.student) await verifyStudentPurchase(flags.student);
  if (flags.payment) await verifyRefund(flags.payment);
  if (flags.teacher) await verifySubscription(flags.teacher);

  console.log();
  if (failures === 0) {
    console.log("\x1b[32mUAT verify: all checks passed\x1b[0m");
  } else {
    console.log(`\x1b[31mUAT verify: ${failures} check(s) FAILED\x1b[0m`);
  }
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
