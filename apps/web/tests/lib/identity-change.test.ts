import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth/identity-change.ts — the shared mechanics behind the Google-OAuth
// account-takeover fix: an email change must disconnect any linked OAuth
// (Google) Account row and sign out other sessions, regardless of which
// caller (teacher/student self-service or admin) triggers it. See
// tests/teachers/email-change.test.ts and tests/students/email-change.test.ts
// for the callers that assert THESE functions get invoked; this file asserts
// what they actually do against Prisma/better-auth.

const USER_ID = "55555555-5555-4555-8555-555555555555";

const state: {
  accounts: Array<{ id: string; userId: string; providerId: string }>;
  deleteManyCalls: Array<{ where: unknown }>;
  revokeOtherSessionsCalls: number;
  revokeOtherSessionsError: Error | null;
  deleteManySessionsCalls: Array<{ where: unknown }>;
} = {
  accounts: [],
  deleteManyCalls: [],
  revokeOtherSessionsCalls: 0,
  revokeOtherSessionsError: null,
  deleteManySessionsCalls: [],
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=abc" }) }));

vi.mock("@/lib/auth/server", () => ({
  auth: {
    api: {
      revokeOtherSessions: async (_input: { headers: Headers }) => {
        state.revokeOtherSessionsCalls += 1;
        if (state.revokeOtherSessionsError) throw state.revokeOtherSessionsError;
        return { status: true };
      },
    },
  },
}));

const logWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: logWarn, info: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: async (args: { where: { userId: string } }) =>
        state.accounts
          .filter((a) => a.userId === args.where.userId)
          .map((a) => ({ providerId: a.providerId })),
      deleteMany: async (args: { where: unknown }) => {
        state.deleteManyCalls.push(args);
        return { count: state.accounts.length };
      },
    },
    session: {
      deleteMany: async (args: { where: unknown }) => {
        state.deleteManySessionsCalls.push(args);
        return { count: 1 };
      },
    },
  },
}));

const { disconnectOAuthAccounts, revokeOtherSessionsBestEffort, revokeAllSessionsForUser } =
  await import("@/lib/auth/identity-change");

beforeEach(() => {
  vi.clearAllMocks();
  state.accounts = [];
  state.deleteManyCalls = [];
  state.revokeOtherSessionsCalls = 0;
  state.revokeOtherSessionsError = null;
  state.deleteManySessionsCalls = [];
});

describe("disconnectOAuthAccounts", () => {
  it("deletes every linked Account row for the user and reports which providers were removed", async () => {
    state.accounts = [{ id: "a1", userId: USER_ID, providerId: "google" }];
    const result = await disconnectOAuthAccounts(USER_ID);
    expect(result).toEqual({ disconnectedProviders: ["google"] });
    expect(state.deleteManyCalls).toEqual([{ where: { userId: USER_ID } }]);
  });

  it("de-duplicates provider names when more than one OAuth account is linked", async () => {
    state.accounts = [
      { id: "a1", userId: USER_ID, providerId: "google" },
      { id: "a2", userId: USER_ID, providerId: "google" },
    ];
    const result = await disconnectOAuthAccounts(USER_ID);
    expect(result.disconnectedProviders).toEqual(["google"]);
  });

  it("is a no-op (skips the delete call entirely) when nothing is linked", async () => {
    state.accounts = [];
    const result = await disconnectOAuthAccounts(USER_ID);
    expect(result).toEqual({ disconnectedProviders: [] });
    expect(state.deleteManyCalls).toHaveLength(0);
  });

  it("never touches another user's linked accounts", async () => {
    state.accounts = [{ id: "a1", userId: "someone-else", providerId: "google" }];
    const result = await disconnectOAuthAccounts(USER_ID);
    expect(result).toEqual({ disconnectedProviders: [] });
    expect(state.deleteManyCalls).toHaveLength(0);
  });
});

describe("revokeOtherSessionsBestEffort", () => {
  it("calls auth.api.revokeOtherSessions with the current request's headers", async () => {
    await revokeOtherSessionsBestEffort();
    expect(state.revokeOtherSessionsCalls).toBe(1);
  });

  it("swallows a failure instead of throwing (best-effort by contract)", async () => {
    state.revokeOtherSessionsError = new Error("no session in context");
    await expect(revokeOtherSessionsBestEffort()).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalled();
  });
});

describe("revokeAllSessionsForUser", () => {
  it("deletes every session row for the given user id directly (not 'other than current')", async () => {
    await revokeAllSessionsForUser(USER_ID);
    expect(state.deleteManySessionsCalls).toEqual([{ where: { userId: USER_ID } }]);
  });

  it("swallows a failure instead of throwing", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.spyOn(prisma.session, "deleteMany").mockRejectedValueOnce(new Error("db down"));
    await expect(revokeAllSessionsForUser(USER_ID)).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalled();
  });
});
