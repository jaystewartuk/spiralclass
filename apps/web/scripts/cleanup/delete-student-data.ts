// Roster reset — deletes a teacher's student PACKAGES and BOOKINGS (classes),
// and the rows that hang off them (payments, class materials, and the
// notifications that referenced them). Service-role: bypasses RLS. SILENT by
// design — it emits no Inngest events, so no confirmations/reminders/
// WhatsApp/email ever fire. The inverse of scripts/import/import.ts.
//
// What it does NOT touch:
//   * package_templates  — the teacher's reusable package definitions stay.
//   * students + teacher_students — the roster (and notification prefs / the
//     silent-onboarding hold) stays, so re-created packages/classes still go
//     to the same, already-silenced student rows.
//   * levels, library, availability, Stripe/Wise/subscription state.
//
// Use case: a teacher who imported (or hand-entered) a first pass of packages
// and classes wants to wipe just that activity and re-enter it cleanly from
// her notebook, without deleting students or re-doing onboarding.
//
// Usage:
//   pnpm cleanup:roster --teacher <slug-or-id>            # dry run (counts only)
//   pnpm cleanup:roster --teacher <slug-or-id> --commit   # delete
//   pnpm cleanup:roster --teacher <uuid> --emit-sql       # write DELETEs to a .sql file
//
// Always dry-runs first. --commit is the only thing that writes. Deletion is
// not reversible — take a DB snapshot/backup before --commit.

import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";

// --- CLI args ---

interface Args {
  teacher: string;
  commit: boolean;
  // Skip the DB entirely and print the DELETE SQL to a file instead of
  // running it through Prisma — for environments that can only reach the
  // target DB through a SQL console / MCP (no direct connection string). In
  // this mode `--teacher` MUST be the teacher's UUID; it's used verbatim to
  // scope every DELETE (there's no DB to resolve a slug against).
  emitSql: boolean;
  // Where --emit-sql writes. Defaults to ./cleanup-student-data.sql in cwd.
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const teacher = get("--teacher");
  if (!teacher) {
    throw new Error(
      "Usage: pnpm cleanup:roster --teacher <slug-or-id> [--commit] [--emit-sql] [--out <file>]",
    );
  }
  return {
    teacher,
    commit: argv.includes("--commit"),
    emitSql: argv.includes("--emit-sql"),
    out: get("--out") ?? "cleanup-student-data.sql",
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Emit SQL mode ---
// One transaction, ordered so foreign keys never block:
//   1. notifications referencing this teacher's bookings/payments (no FK, but
//      they'd otherwise dangle and break the in-app inbox re-render).
//   2. booking-scoped library_materials (child of bookings — D-69 merge of
//      the old class_materials table; also covers each booking's content
//      material) — cascade would handle it, kept explicit so the count is
//      visible.
//   3. bookings (the classes).
//   4. payments (child of packages) — likewise cascade-covered but explicit.
//   5. packages.
// Bookings must go before packages (bookings.package_id is ON DELETE RESTRICT);
// children before parents everywhere else.
function buildSql(teacherId: string): string {
  const t = `'${teacherId}'`;
  return (
    [
      "BEGIN;",
      `DELETE FROM notifications WHERE teacher_id = ${t} AND (booking_id IS NOT NULL OR payment_id IS NOT NULL);`,
      `DELETE FROM library_materials WHERE booking_id IN (SELECT id FROM bookings WHERE teacher_id = ${t});`,
      `DELETE FROM bookings WHERE teacher_id = ${t};`,
      `DELETE FROM payments WHERE package_id IN (SELECT id FROM packages WHERE teacher_id = ${t});`,
      `DELETE FROM packages WHERE teacher_id = ${t};`,
      "COMMIT;",
    ].join("\n") + "\n"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.emitSql) {
    if (!UUID_RE.test(args.teacher)) {
      console.error("\n✗ --emit-sql requires --teacher to be the teacher UUID");
      process.exit(1);
    }
    const outPath = resolve(process.cwd(), args.out);
    writeFileSync(outPath, buildSql(args.teacher), "utf8");
    console.error(`\nWrote roster-reset SQL for teacher ${args.teacher} to ${outPath}`);
    console.error("Review it, then run it against the target DB inside a transaction.\n");
    return;
  }

  const prisma = new PrismaClient({ adapter: envAdapter() });
  const teacher = await prisma.teacher.findFirst({
    where: { OR: [{ bookingSlug: args.teacher }, { id: args.teacher }] },
    select: { id: true, name: true, bookingSlug: true },
  });
  if (!teacher) {
    console.error(`\n✗ teacher not found for '${args.teacher}'`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`\nTeacher: ${teacher.name} (${teacher.bookingSlug}) — ${teacher.id}`);

  // Count what's in scope so the dry run shows exactly what --commit removes.
  const teacherId = teacher.id;
  const [packages, bookings, payments, materials, notifications] = await Promise.all([
    prisma.package.count({ where: { teacherId } }),
    prisma.booking.count({ where: { teacherId } }),
    prisma.payment.count({ where: { package: { teacherId } } }),
    // Booking-scoped rows only (D-69 merge) — a reusable library item
    // (bookingId null) isn't part of this teacher's booking cleanup.
    prisma.libraryMaterial.count({ where: { teacherId, bookingId: { not: null } } }),
    prisma.notification.count({
      where: {
        teacherId,
        OR: [{ bookingId: { not: null } }, { paymentId: { not: null } }],
      },
    }),
  ]);

  console.log("\nIn scope for deletion:");
  console.log(`  packages:               ${packages}`);
  console.log(`  bookings (classes):     ${bookings}`);
  console.log(`  payments:               ${payments}`);
  console.log(`  class materials:        ${materials}`);
  console.log(`  notifications (refs):   ${notifications}`);
  console.log("\nKept: package templates, students, roster links, levels, library, availability.");

  if (packages + bookings === 0) {
    console.log("\nNothing to delete — this teacher has no packages or bookings.\n");
    await prisma.$disconnect();
    return;
  }

  if (!args.commit) {
    console.log("\nDry run — nothing deleted. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  // --- Commit. One transaction; order matters (see buildSql above). ---
  const result = await prisma.$transaction(async (tx) => {
    const delNotifs = await tx.notification.deleteMany({
      where: {
        teacherId,
        OR: [{ bookingId: { not: null } }, { paymentId: { not: null } }],
      },
    });
    // Deleting bookings cascades their booking-scoped library_materials
    // (D-69); deleting packages cascades payments (both FKs are ON DELETE
    // CASCADE). We still delete bookings before packages because
    // bookings.package_id is ON DELETE RESTRICT.
    const delBookings = await tx.booking.deleteMany({ where: { teacherId } });
    const delPackages = await tx.package.deleteMany({ where: { teacherId } });
    return { delNotifs, delBookings, delPackages };
  });

  console.log(
    `\n✓ deleted: ${result.delPackages.count} packages, ${result.delBookings.count} bookings ` +
      `(+ their payments & materials by cascade), ${result.delNotifs.count} notifications.`,
  );
  console.log("No notifications were sent. The roster and package templates are untouched.\n");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
