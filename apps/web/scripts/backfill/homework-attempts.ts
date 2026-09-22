// Backfill HomeworkAttempt rows for HomeworkSubmissions that predate the
// attempt-history schema (docs/features/homework.md, D-93). The
// shipped homework feature only ever had ONE state per (assignment, student)
// — a resubmission overwrote the same row in place — so every submitted
// row's entire history is exactly one attempt: attempt 1, a snapshot of the
// submission's current textResponse/submittedAt. Draft-only submissions
// (never submitted) get no attempt — there's nothing to snapshot yet.
//
// Idempotent: skips any submission that already has an attempt (safe to
// re-run after a partial run, or after new real submissions land — those
// already get their attempt created by the live submit flow, so this backfill
// only ever touches pre-existing rows).
//
// Usage:
//   pnpm backfill:homework-attempts            # dry run, counts only
//   pnpm backfill:homework-attempts --commit   # apply

import { PrismaClient } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";

async function main() {
  const commit = process.argv.includes("--commit");
  const prisma = new PrismaClient({ adapter: envAdapter() });

  const submissions = await prisma.homeworkSubmission.findMany({
    where: {
      status: { in: ["submitted", "returned", "graded"] },
      attempts: { none: {} },
    },
    select: {
      id: true,
      textResponse: true,
      submittedAt: true,
      updatedAt: true,
      files: { where: { attemptId: null }, select: { id: true } },
    },
  });

  console.log(`\nSubmissions needing a backfilled attempt: ${submissions.length}`);
  const fileCount = submissions.reduce((sum, s) => sum + s.files.length, 0);
  console.log(`Submission files to attribute to that attempt: ${fileCount}`);

  if (submissions.length === 0) {
    console.log("\nNothing to backfill.\n");
    await prisma.$disconnect();
    return;
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  let created = 0;
  let filesAttributed = 0;
  for (const submission of submissions) {
    await prisma.$transaction(async (tx) => {
      const attempt = await tx.homeworkAttempt.create({
        data: {
          submissionId: submission.id,
          attemptNumber: 1,
          textResponse: submission.textResponse,
          // submittedAt should always be set for submitted/returned/graded;
          // fall back defensively rather than fail the whole backfill on an
          // inconsistent legacy row.
          submittedAt: submission.submittedAt ?? submission.updatedAt,
        },
      });
      if (submission.files.length > 0) {
        const result = await tx.homeworkSubmissionFile.updateMany({
          where: { id: { in: submission.files.map((f) => f.id) } },
          data: { attemptId: attempt.id },
        });
        filesAttributed += result.count;
      }
    });
    created += 1;
  }

  console.log(`\n✓ created ${created} attempts, attributed ${filesAttributed} files.\n`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
