// Re-stamp roster students whose `locale` was hardcoded to es-MX at creation.
//
// Both student-creation paths used to hardcode `locale: "es-MX"` regardless of
// who the student actually was:
//   - lib/students/find-or-create.ts  (public checkout funnel)
//   - lib/invitations/manage.ts       (provisionInvitation)
// …even though the column defaults to "en" and the student-facing funnel is
// English on purpose. The dispatcher reads `student.locale` for every
// student-facing notification (lib/notifications/dispatcher.ts), so an
// English-speaking student stamped es-MX gets Spanish class reminders and
// booking confirmations forever. Both call sites are fixed; this re-stamps the
// rows they already wrote.
//
// SCOPED BY TEACHER ON PURPOSE. There is no way to infer, after the fact,
// which of a teacher's students actually read Spanish — the column recorded
// the bug, not a preference. So this never sweeps the whole table: you name
// the teacher whose roster you know the answer for. A teacher whose students
// genuinely read Spanish needs no run at all.
//
// Only touches rows still sitting on the exact hardcoded value, so it can't
// clobber a student who has since chosen a locale, and is safe to re-run.
//
// Usage:
//   pnpm backfill:student-locale --teacher <teacherId>              # dry run
//   pnpm backfill:student-locale --teacher <teacherId> --commit
//   pnpm backfill:student-locale --teacher <teacherId> --to es-MX --commit

import { PrismaClient } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";

// The value the two creation paths used to hardcode. Rows on any other locale
// were set deliberately somewhere and are never touched.
const STAMPED_BY_BUG = "es-MX";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const commit = process.argv.includes("--commit");
  const teacherId = argValue("--teacher");
  const to = argValue("--to") ?? "en";

  if (!teacherId) {
    console.error("\nRefusing to run without --teacher <teacherId>.");
    console.error("This script is deliberately teacher-scoped — see the header.\n");
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: envAdapter() });

  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { id: true, name: true, email: true, locale: true },
  });
  if (!teacher) {
    console.error(`\nNo teacher with id ${teacherId}.\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const students = await prisma.student.findMany({
    where: {
      locale: STAMPED_BY_BUG,
      teacherStudents: { some: { teacherId } },
    },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\nTeacher: ${teacher.name} <${teacher.email}> (own locale: ${teacher.locale})`);
  console.log(`Students still on the hardcoded "${STAMPED_BY_BUG}": ${students.length}`);
  console.log(`Would set locale -> "${to}"\n`);
  for (const s of students) {
    console.log(`  ${s.name} <${s.email ?? "no email"}>`);
  }

  if (!commit) {
    console.log("\nDry run. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  // Re-assert the locale filter in the write so a row that changed between the
  // read and the write isn't clobbered.
  const result = await prisma.student.updateMany({
    where: {
      id: { in: students.map((s) => s.id) },
      locale: STAMPED_BY_BUG,
    },
    data: { locale: to },
  });

  console.log(`\n✓ updated ${result.count} students to "${to}".\n`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
