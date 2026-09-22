// Connect a teacher's Wise Business profile for automated reconciliation.
//
// Generates an SCA signing keypair, stores the private half (encrypted) plus
// the teacher's API token + profile id on their Teacher row, and prints the
// PUBLIC key for the teacher to upload under Wise → Settings → API tokens.
// Auto-reconcile goes live on the next poll-wise-statements tick once that
// public key is uploaded.
//
// Usage:
//   pnpm wise:connect <teacherId> <wiseProfileId> <wiseApiToken>
//
// The token is read from argv for convenience; prefer piping or an env var
// in shared shells so it doesn't land in history.

import { PrismaClient } from "@prisma/client";
import { envAdapter } from "@/lib/db-pool";
import { connectTeacherWise } from "@/lib/wise/credentials";

async function main() {
  const [teacherId, profileId, token] = process.argv.slice(2);
  if (!teacherId || !profileId || !token) {
    console.error("Usage: pnpm wise:connect <teacherId> <wiseProfileId> <wiseApiToken>");
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: envAdapter() });
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id: teacherId },
      select: { id: true, email: true, wisePaymentsEnabled: true },
    });
    if (!teacher) {
      console.error(`No teacher with id ${teacherId}`);
      process.exit(1);
    }

    const { publicKeyPem } = await connectTeacherWise(prisma, {
      teacherId,
      profileId,
      token,
    });

    console.log(`\nConnected Wise for ${teacher.email} (${teacher.id}).`);
    if (!teacher.wisePaymentsEnabled) {
      console.log(
        "NOTE: wisePaymentsEnabled is false — enable Wise in their settings or the cron will skip them.",
      );
    }
    console.log("\nGive the teacher this PUBLIC key to upload in Wise → Settings → API tokens:\n");
    console.log(publicKeyPem);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
