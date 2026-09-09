/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { BILLING_HISTORY_LIMIT, listBillingHistory } from "@/lib/subscriptions/invoices";

// A prisma stand-in that records the query, because the shape of the query IS
// the behaviour here: which rows are excluded, what order they come back in,
// and how many.
function recordingPrisma() {
  const calls: any[] = [];
  const db = {
    subscriptionInvoice: {
      async findMany(args: any) {
        calls.push(args);
        return [];
      },
    },
  } as any;
  return { db, calls };
}

describe("listBillingHistory", () => {
  it("reads only this teacher's invoices, newest first, capped", async () => {
    const { db, calls } = recordingPrisma();
    await listBillingHistory("t1", db);
    expect(calls[0].where.teacherId).toBe("t1");
    expect(calls[0].orderBy).toEqual({ periodStart: "desc" });
    expect(calls[0].take).toBe(BILLING_HISTORY_LIMIT);
  });

  // A voided invoice was never owed and never paid. Showing it invites the
  // "was I charged twice?" question that the row itself cannot answer. A
  // FAILED one stays — that is the row she needs to see.
  it("hides voided invoices and keeps failed ones", async () => {
    const { db, calls } = recordingPrisma();
    await listBillingHistory("t1", db);
    expect(calls[0].where.status).toEqual({ not: "void" });
  });

  it("takes an explicit limit for a caller that wants fewer", async () => {
    const { db, calls } = recordingPrisma();
    await listBillingHistory("t1", db, 3);
    expect(calls[0].take).toBe(3);
  });
});
