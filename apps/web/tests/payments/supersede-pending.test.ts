import { describe, expect, it, vi } from "vitest";
import { supersedePendingCheckouts } from "@/lib/payments/supersede-pending";

// MED-4: a new checkout supersedes the student's still-pending checkouts
// for the same template so two payable rails can't co-exist for one intent.

const PARAMS = { teacherId: "t1", studentId: "s1", templateId: "tpl1" };

type Pay = {
  id: string;
  provider: "stripe" | "manual_transfer";
  stripeCheckoutSessionId: string | null;
  studentMarkedSentAt?: Date | null;
};
type Pkg = {
  id: string;
  status: string;
  payments: Pay[];
  // Optional per-fixture override; defaults below. Present because the
  // expire call is scoped to the teacher's connected account (D-143).
  teacherStripeAccountId?: string | null;
};

function fakeDeps(packages: Pkg[], opts: { expireThrowsFor?: Set<string> } = {}) {
  const expired: string[] = [];
  const updates: Array<{ id: string; status: string }> = [];
  const prisma = {
    package: {
      // Mirror the real query: status=pending AND every payment pending AND
      // (when the query asks for it) no payment marked-sent by the student.
      findMany: vi.fn(async ({ where }: any) => {
        const noneMarkedSent = Boolean(where.payments?.none?.studentMarkedSentAt);
        return packages
          .filter((p) => p.status === where.status)
          .filter(
            (p) => !noneMarkedSent || !p.payments.some((pay) => pay.studentMarkedSentAt != null),
          )
          .map((p) => ({
            id: p.id,
            // D-143: the real query now selects the teacher's connected
            // account, because expiring a session needs Stripe-Account — the
            // session lives on HER account, and a platform-scoped expire would
            // 404 and leave a live session able to take a late payment.
            teacher: { stripeAccountId: p.teacherStripeAccountId ?? "acct_teacher_1" },
            payments: p.payments.map((pay) => ({
              id: pay.id,
              provider: pay.provider,
              stripeCheckoutSessionId: pay.stripeCheckoutSessionId,
            })),
          }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, status: data.status });
        return {};
      }),
    },
    payment: {},
  };
  const stripe = {
    expireCheckoutSession: vi.fn(async (sessionId: string, _connectedAccountId?: string) => {
      if (opts.expireThrowsFor?.has(sessionId)) {
        throw new Error("session already resolved");
      }
      expired.push(sessionId);
      return {} as never;
    }),
  };
  return {
    deps: { prisma: prisma as never, getStripe: () => stripe as never },
    expired,
    updates,
    stripe,
  };
}

describe("supersedePendingCheckouts", () => {
  it("expires the Stripe session and marks the old package expired", async () => {
    const { deps, expired, updates } = fakeDeps([
      {
        id: "pkg1",
        status: "pending",
        payments: [{ id: "pay1", provider: "stripe", stripeCheckoutSessionId: "cs_old" }],
      },
    ]);
    const out = await supersedePendingCheckouts(PARAMS, deps);
    expect(out.superseded).toBe(1);
    expect(expired).toEqual(["cs_old"]);
    expect(updates).toEqual([{ id: "pkg1", status: "expired" }]);
  });

  it("supersedes a Wise package with no session to expire", async () => {
    const { deps, expired, updates } = fakeDeps([
      {
        id: "pkg2",
        status: "pending",
        payments: [{ id: "pay2", provider: "manual_transfer", stripeCheckoutSessionId: null }],
      },
    ]);
    const out = await supersedePendingCheckouts(PARAMS, deps);
    expect(out.superseded).toBe(1);
    expect(expired).toEqual([]);
    expect(updates).toEqual([{ id: "pkg2", status: "expired" }]);
  });

  it("never supersedes a Wise checkout the student already marked as sent (money in flight)", async () => {
    // Regression: expiring a marked-sent Wise checkout stranded the
    // student's transfer — confirming its payment later activated nothing.
    const { deps, updates } = fakeDeps([
      {
        id: "pkg5",
        status: "pending",
        payments: [
          {
            id: "pay5",
            provider: "manual_transfer",
            stripeCheckoutSessionId: null,
            studentMarkedSentAt: new Date("2026-06-01T10:00:00Z"),
          },
        ],
      },
    ]);
    const out = await supersedePendingCheckouts(PARAMS, deps);
    expect(out.superseded).toBe(0);
    expect(updates).toEqual([]);
  });

  it("leaves the package alone when expiring the session fails (could still be paid)", async () => {
    const { deps, updates } = fakeDeps(
      [
        {
          id: "pkg3",
          status: "pending",
          payments: [{ id: "pay3", provider: "stripe", stripeCheckoutSessionId: "cs_paid" }],
        },
      ],
      { expireThrowsFor: new Set(["cs_paid"]) },
    );
    const out = await supersedePendingCheckouts(PARAMS, deps);
    expect(out.superseded).toBe(0);
    expect(updates).toEqual([]);
  });

  it("never constructs the Stripe client when there's no session to expire", async () => {
    const getStripe = vi.fn(() => {
      throw new Error("stripe should not be constructed");
    });
    const prisma = {
      package: {
        findMany: vi.fn(async () => [
          {
            id: "pkg4",
            payments: [{ id: "p", provider: "manual_transfer", stripeCheckoutSessionId: null }],
          },
        ]),
        update: vi.fn(async () => ({})),
      },
      payment: {},
    };
    const out = await supersedePendingCheckouts(PARAMS, {
      prisma: prisma as never,
      getStripe: getStripe as never,
    });
    expect(out.superseded).toBe(1);
    expect(getStripe).not.toHaveBeenCalled();
  });
});
