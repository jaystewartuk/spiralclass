import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupAbandonedPendingPackages } from "@/lib/payments/cleanup-pending";

const NOW = new Date("2026-04-26T00:00:00Z");
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
const SIX_DAYS_AGO = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000);
const FIFTEEN_DAYS_AGO = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
const TEN_DAYS_AGO = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);

type PaymentRow = {
  status: "pending" | "paid" | "failed" | "refunded";
  provider: "stripe" | "manual_transfer";
  createdAt: Date;
  studentMarkedSentAt?: Date | null;
};
type PackageRow = {
  id: string;
  status: "pending" | "active" | "expired" | "refunded" | "paused";
  createdAt: Date;
  payments: PaymentRow[];
};

type FakeState = { packages: PackageRow[]; failDeleteIds?: Set<string> };

// `where.payments.every` now carries an OR with provider-specific cutoffs,
// plus a marked-sent exclusion. The fake walks all of these so the test
// mirrors the production query.
type EveryClause = {
  status: PaymentRow["status"];
  studentMarkedSentAt?: null;
  OR?: Array<{
    provider: PaymentRow["provider"];
    createdAt: { lt: Date };
  }>;
};

function matchesEvery(p: PackageRow, every: EveryClause | undefined): boolean {
  if (!every) return true;
  return p.payments.every((pay) => {
    if (pay.status !== every.status) return false;
    if (every.studentMarkedSentAt === null && pay.studentMarkedSentAt != null) {
      return false;
    }
    if (every.OR) {
      return every.OR.some((b) => b.provider === pay.provider && pay.createdAt < b.createdAt.lt);
    }
    return true;
  });
}

function fakePrisma(state: FakeState) {
  return {
    package: {
      findMany: vi.fn(async ({ where, take }: any) => {
        const matched = state.packages.filter((p) => {
          if (p.status !== where.status) return false;
          return matchesEvery(p, where.payments?.every);
        });
        return typeof take === "number" ? matched.slice(0, take) : matched;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (state.failDeleteIds?.has(where.id)) {
          throw new Error(`simulated delete failure: ${where.id}`);
        }
        const p = state.packages.find((x) => x.id === where.id);
        // Re-assert the guard at delete time (the TOCTOU re-check).
        if (!p || p.status !== where.status || !matchesEvery(p, where.payments?.every)) {
          return { count: 0 };
        }
        state.packages = state.packages.filter((x) => x.id !== where.id);
        return { count: 1 };
      }),
    },
  } as any;
}

describe("cleanupAbandonedPendingPackages", () => {
  let state: FakeState;

  beforeEach(() => {
    state = { packages: [] };
  });

  it("deletes pending Stripe packages older than 7 days", async () => {
    state.packages = [
      {
        id: "abandoned",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({ scanned: 1, packagesDeleted: 1, skipped: 0, failed: 0 });
    expect(state.packages).toHaveLength(0);
  });

  it("leaves pending Stripe packages younger than 7 days alone", async () => {
    state.packages = [
      {
        id: "fresh-pending",
        status: "pending",
        createdAt: SIX_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: SIX_DAYS_AGO }],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({ scanned: 0, packagesDeleted: 0, skipped: 0, failed: 0 });
    expect(state.packages).toHaveLength(1);
  });

  it("gives Wise packages a 14-day grace window (not 7)", async () => {
    // 10 days old: past the Stripe cutoff but within the Wise window.
    state.packages = [
      {
        id: "wise-recent",
        status: "pending",
        createdAt: TEN_DAYS_AGO,
        payments: [{ status: "pending", provider: "manual_transfer", createdAt: TEN_DAYS_AGO }],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome.packagesDeleted).toBe(0);
    expect(state.packages).toHaveLength(1);
  });

  it("deletes pending Wise packages once past the 14-day window", async () => {
    state.packages = [
      {
        id: "wise-stale",
        status: "pending",
        createdAt: FIFTEEN_DAYS_AGO,
        payments: [{ status: "pending", provider: "manual_transfer", createdAt: FIFTEEN_DAYS_AGO }],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({ scanned: 1, packagesDeleted: 1, skipped: 0, failed: 0 });
  });

  it("never touches active packages", async () => {
    state.packages = [
      {
        id: "active",
        status: "active",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "paid", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({ scanned: 0, packagesDeleted: 0, skipped: 0, failed: 0 });
    expect(state.packages).toHaveLength(1);
  });

  it("skips a pending package whose payment actually settled (defense-in-depth)", async () => {
    state.packages = [
      {
        id: "in-flight",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "paid", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome.packagesDeleted).toBe(0);
    expect(state.packages).toHaveLength(1);
  });

  it("is idempotent — second run finds no candidates", async () => {
    state.packages = [
      {
        id: "abandoned",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
    ];
    const prisma = fakePrisma(state);

    await cleanupAbandonedPendingPackages({ prisma, now: () => NOW });
    const second = await cleanupAbandonedPendingPackages({ prisma, now: () => NOW });

    expect(second).toEqual({ scanned: 0, packagesDeleted: 0, skipped: 0, failed: 0 });
  });

  it("continues past a failed delete and reports it instead of throwing", async () => {
    state.packages = [
      {
        id: "ok-1",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
      {
        id: "boom",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
      {
        id: "ok-2",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
    ];
    state.failDeleteIds = new Set(["boom"]);

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({ scanned: 3, packagesDeleted: 2, skipped: 0, failed: 1 });
    // The two healthy rows are gone; the failed one survives for the next run.
    expect(state.packages.map((p) => p.id)).toEqual(["boom"]);
  });

  it("never deletes a Wise package whose student already marked the transfer as sent", async () => {
    // Regression: money is in flight (payment stays 'pending' until the
    // teacher confirms). Hard-deleting would destroy the only record of it.
    state.packages = [
      {
        id: "wise-marked-sent",
        status: "pending",
        createdAt: FIFTEEN_DAYS_AGO,
        payments: [
          {
            status: "pending",
            provider: "manual_transfer",
            createdAt: FIFTEEN_DAYS_AGO,
            studentMarkedSentAt: TEN_DAYS_AGO,
          },
        ],
      },
    ];

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({ scanned: 0, packagesDeleted: 0, skipped: 0, failed: 0 });
    expect(state.packages).toHaveLength(1);
  });

  it("skips (does not delete) a candidate that got paid between the scan and the delete", async () => {
    // TOCTOU: the row matches at scan time, then a Wise confirm flips it to
    // active/paid before the delete. The guarded deleteMany must match 0 rows.
    state.packages = [
      {
        id: "raced",
        status: "pending",
        createdAt: EIGHT_DAYS_AGO,
        payments: [{ status: "pending", provider: "stripe", createdAt: EIGHT_DAYS_AGO }],
      },
    ];
    const prisma = fakePrisma(state);
    const origFindMany = prisma.package.findMany;
    prisma.package.findMany = vi.fn(async (args: any) => {
      const rows = await origFindMany(args);
      // The confirm lands right after the scan returns.
      const p = state.packages.find((x) => x.id === "raced")!;
      p.status = "active";
      p.payments[0].status = "paid";
      return rows;
    });

    const outcome = await cleanupAbandonedPendingPackages({ prisma, now: () => NOW });

    expect(outcome).toEqual({ scanned: 1, packagesDeleted: 0, skipped: 1, failed: 0 });
    // The now-active package survives — its classes aren't revoked.
    expect(state.packages.map((p) => p.id)).toEqual(["raced"]);
  });

  it("caps deletions per run at maxDeletions", async () => {
    state.packages = Array.from({ length: 5 }, (_, i) => ({
      id: `p-${i}`,
      status: "pending" as const,
      createdAt: EIGHT_DAYS_AGO,
      payments: [
        { status: "pending" as const, provider: "stripe" as const, createdAt: EIGHT_DAYS_AGO },
      ],
    }));

    const outcome = await cleanupAbandonedPendingPackages({
      prisma: fakePrisma(state),
      now: () => NOW,
      maxDeletions: 2,
    });

    expect(outcome).toEqual({ scanned: 2, packagesDeleted: 2, skipped: 0, failed: 0 });
    expect(state.packages).toHaveLength(3);
  });
});
