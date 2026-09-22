import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth/google-link-status.ts — read-only lookup the settings pages and
// buildMobileSessionUser use to decide "Connect Google" vs "Reconnect
// Google". Only asserting the query shape here: it must be scoped to this
// exact user id and the "google" provider (never a cross-user leak).

const state = { accounts: [] as Array<{ userId: string; providerId: string; accountId: string }> };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      // Mirrors real Prisma's `select` projection (the real query selects
      // only `accountId`) so this fake behaves the same as the production
      // client instead of leaking the whole row.
      findFirst: async (args: { where: { userId: string; providerId: string } }) => {
        const found = state.accounts.find(
          (a) => a.userId === args.where.userId && a.providerId === args.where.providerId,
        );
        return found ? { accountId: found.accountId } : null;
      },
    },
  },
}));

const { getLinkedGoogleAccount } = await import("@/lib/auth/google-link-status");

beforeEach(() => {
  state.accounts = [];
});

describe("getLinkedGoogleAccount", () => {
  it("returns the linked account when a google Account row exists for this user", async () => {
    state.accounts = [{ userId: "u1", providerId: "google", accountId: "sub-123" }];
    const result = await getLinkedGoogleAccount("u1");
    expect(result).toEqual({ accountId: "sub-123" });
  });

  it("returns null when no google account is linked for this user", async () => {
    const result = await getLinkedGoogleAccount("u1");
    expect(result).toBeNull();
  });

  it("never returns a different user's linked account", async () => {
    state.accounts = [{ userId: "someone-else", providerId: "google", accountId: "sub-999" }];
    const result = await getLinkedGoogleAccount("u1");
    expect(result).toBeNull();
  });
});
