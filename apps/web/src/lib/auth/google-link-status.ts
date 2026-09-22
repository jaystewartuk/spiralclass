import { prisma } from "@/lib/prisma";

// Read-only lookup used by the settings UI (web card + mobile screens) to
// decide whether to show "Connect Google" or "Reconnect Google", and by the
// email-change flow's warning copy. A user has at most one `google` Account
// row (unique on [providerId, accountId], and better-auth upserts on that
// pair) — Google is the only social provider this app configures.
export async function getLinkedGoogleAccount(
  userId: string,
): Promise<{ accountId: string } | null> {
  const account = await prisma.account.findFirst({
    where: { userId, providerId: "google" },
    select: { accountId: true },
  });
  return account;
}
