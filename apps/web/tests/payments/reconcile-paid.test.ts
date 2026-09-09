import { describe, expect, it } from "vitest";
import { reconcileStrandedPaidPayments } from "@/lib/payments/reconcile-paid";

// Backstop for a lost post-payment fan-out. ONE stranded-signal serves both
// rails since D-143: a purchase whose intended slot was never consumed — the
// student paid, and the class she picked was silently never booked. Before
// that the Stripe arm used its own signal (a settled payment whose teacher
// transfer never ran); direct charges removed the transfer, so there is no
// payout step left on either rail to detect. The sweep re-emits payment.paid
// so auto-book / referral / magic-link get re-driven (all idempotent).

const NOW = new Date("2026-06-12T12:00:00.000Z");

type P = {
  id: string;
  provider: string;
  status: string;
  paidAt: Date | null;
  packageId: string;
  teacherId: string;
  studentId: string;
  intendedStartUtc: Date | null;
  classesUsed: number;
  packageStatus: string;
};

function pay(over: Partial<P> & { id: string }): P {
  return {
    provider: "stripe",
    status: "paid",
    // 1h ago: past the 15-min grace, well within the 3-day horizon.
    paidAt: new Date(NOW.getTime() - 60 * 60_000),
    packageId: `pkg-${over.id}`,
    teacherId: "t1",
    studentId: "s1",
    // Unconsumed intent — the stranded-signal itself, so a bare pay() is the
    // shape the sweep is meant to catch.
    intendedStartUtc: new Date(NOW.getTime() + 24 * 3600_000),
    classesUsed: 0,
    packageStatus: "active",
    ...over,
  };
}

/** The same stranded shape on the manual-transfer rail. */
function wisePay(over: Partial<P> & { id: string }): P {
  return pay({ provider: "manual_transfer", ...over });
}

// Evaluates the query's where-clause against a fixture row. A real evaluator
// rather than a few `if`s: a fake that ignored the package predicates would
// match every row and quietly pass every test in this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchesClause(p: P, clause: any): boolean {
  if (!clause) return true;
  if (clause.provider && p.provider !== clause.provider) return false;
  if (clause.status && p.status !== clause.status) return false;
  if (clause.paidAt?.gte && !(p.paidAt && p.paidAt >= clause.paidAt.gte)) return false;
  if (clause.paidAt?.lte && !(p.paidAt && p.paidAt <= clause.paidAt.lte)) return false;

  const pkg = clause.package?.is;
  if (pkg) {
    if (pkg.intendedStartUtc?.not === null && p.intendedStartUtc === null) return false;
    if (pkg.classesUsed !== undefined && p.classesUsed !== pkg.classesUsed) return false;
    if (pkg.status !== undefined && p.packageStatus !== pkg.status) return false;
  }

  if (Array.isArray(clause.OR)) {
    return clause.OR.some((sub: unknown) => matchesClause(p, sub));
  }
  return true;
}

// A non-cancelled booking row, as the honoured-intent post-filter sees it.
type B = { teacherId: string; studentId: string; scheduledStart: Date; status: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePrisma(payments: P[], bookings: B[] = []): any {
  return {
    payment: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where, take }: any) => {
        const rows = payments.filter((p) => matchesClause(p, where)).slice(0, take ?? 500);
        return rows.map((p) => ({
          id: p.id,
          provider: p.provider,
          package: {
            id: p.packageId,
            teacherId: p.teacherId,
            studentId: p.studentId,
            intendedStartUtc: p.intendedStartUtc,
          },
        }));
      },
    },
    booking: {
      // Evaluates the batched (teacher, student, start) OR the sweep issues,
      // plus the status exclusion — a fake that returned every row would make
      // the "still stranded" test below pass vacuously.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        const excluded: string[] = where?.status?.notIn ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tuples: any[] = where?.OR ?? [];
        return bookings
          .filter((b) => !excluded.includes(b.status))
          .filter((b) =>
            tuples.some(
              (t) =>
                t.teacherId === b.teacherId &&
                t.studentId === b.studentId &&
                t.scheduledStart.getTime() === b.scheduledStart.getTime(),
            ),
          )
          .map((b) => ({
            teacherId: b.teacherId,
            studentId: b.studentId,
            scheduledStart: b.scheduledStart,
          }));
      },
    },
  };
}

describe("reconcileStrandedPaidPayments", () => {
  it("re-emits payment.paid for a stranded paid card payment", async () => {
    const emitted: Array<{ name: string; data: unknown }> = [];
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([pay({ id: "p1" })]),
      emit: async (e) => void emitted.push(e),
      now: () => NOW,
    });
    expect(out).toEqual({ scanned: 1, reemitted: 1, failed: 0 });
    expect(emitted).toEqual([
      {
        name: "payment.paid",
        data: { paymentId: "p1", packageId: "pkg-p1", teacherId: "t1", studentId: "s1" },
      },
    ]);
  });

  it("ignores payments inside the grace window or past the scan horizon", async () => {
    const tooRecent = pay({ id: "recent", paidAt: new Date(NOW.getTime() - 5 * 60_000) });
    const tooOld = pay({ id: "old", paidAt: new Date(NOW.getTime() - 4 * 24 * 3600_000) });
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([tooRecent, tooOld]),
      emit: async () => {},
      now: () => NOW,
    });
    expect(out.scanned).toBe(0);
  });

  // The Wise rail had no backstop at all until now: confirmTransferPayment emits
  // payment.paid best-effort outside its transaction, so a dropped emit left a
  // paid, teacher-confirmed purchase whose class was never booked — with
  // nothing to re-drive it and nobody aware.
  it("re-emits a Wise purchase whose intended slot was never booked", async () => {
    const emitted: Array<{ name: string; data: unknown }> = [];
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([wisePay({ id: "w1" })]),
      emit: async (e) => void emitted.push(e),
      now: () => NOW,
    });
    expect(out).toEqual({ scanned: 1, reemitted: 1, failed: 0 });
    expect(emitted).toEqual([
      {
        name: "payment.paid",
        data: { paymentId: "w1", packageId: "pkg-w1", teacherId: "t1", studentId: "s1" },
      },
    ]);
  });

  it("skips a Wise purchase whose class was already booked", async () => {
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([wisePay({ id: "w1", classesUsed: 1 })]),
      emit: async () => {},
      now: () => NOW,
    });
    expect(out.scanned).toBe(0);
  });

  it("skips a Wise purchase that never picked a slot (nothing to auto-book)", async () => {
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([wisePay({ id: "w1", intendedStartUtc: null })]),
      emit: async () => {},
      now: () => NOW,
    });
    expect(out.scanned).toBe(0);
  });

  // The booking core spends the soonest-to-expire credit across every active
  // package the student holds with the teacher, so a top-up bought while an
  // older package is still live has its first class booked on the OLDER
  // package: the new one keeps classesUsed 0 forever even though the intent was
  // honoured. The `classesUsed: 0` signal alone would re-emit it every tick for
  // the whole horizon.
  it("skips a Wise top-up whose intended class landed on an older package's credit", async () => {
    const w1 = wisePay({ id: "w1" });
    const emitted: unknown[] = [];
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma(
        [w1],
        [
          {
            teacherId: "t1",
            studentId: "s1",
            scheduledStart: w1.intendedStartUtc as Date,
            status: "scheduled",
          },
        ],
      ),
      emit: async (e) => void emitted.push(e),
      now: () => NOW,
    });
    expect(out).toEqual({ scanned: 0, reemitted: 0, failed: 0 });
    expect(emitted).toHaveLength(0);
  });

  it("still re-emits a Wise purchase whose only booking at that start was cancelled", async () => {
    const w1 = wisePay({ id: "w1" });
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma(
        [w1],
        [
          {
            teacherId: "t1",
            studentId: "s1",
            scheduledStart: w1.intendedStartUtc as Date,
            status: "canceled_by_teacher",
          },
        ],
      ),
      emit: async () => {},
      now: () => NOW,
    });
    expect(out.scanned).toBe(1);
    expect(out.reemitted).toBe(1);
  });

  it("does not let another student's booking at that start mask a stranded intent", async () => {
    const w1 = wisePay({ id: "w1" });
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma(
        [w1],
        [
          {
            teacherId: "t1",
            studentId: "someone-else",
            scheduledStart: w1.intendedStartUtc as Date,
            status: "scheduled",
          },
        ],
      ),
      emit: async () => {},
      now: () => NOW,
    });
    expect(out.scanned).toBe(1);
  });

  it("skips a Wise purchase whose package is no longer active", async () => {
    // auto-book requires an active package, so a refunded/expired one would
    // only ever re-emit into a no-op.
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([wisePay({ id: "w1", packageStatus: "refunded" })]),
      emit: async () => {},
      now: () => NOW,
    });
    expect(out.scanned).toBe(0);
  });

  it("sweeps both rails in one pass", async () => {
    const emitted: Array<{ data: { paymentId: string } }> = [];
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([pay({ id: "s1" }), wisePay({ id: "w1" })]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emit: async (e) => void emitted.push(e as any),
      now: () => NOW,
    });
    expect(out.scanned).toBe(2);
    expect(emitted.map((e) => e.data.paymentId).sort()).toEqual(["s1", "w1"]);
  });

  it("counts a failed emit without aborting the run", async () => {
    let calls = 0;
    const out = await reconcileStrandedPaidPayments({
      prisma: fakePrisma([pay({ id: "p1" }), pay({ id: "p2" })]),
      emit: async () => {
        calls += 1;
        if (calls === 1) throw new Error("inngest down");
      },
      now: () => NOW,
    });
    expect(out.scanned).toBe(2);
    expect(out.reemitted).toBe(1);
    expect(out.failed).toBe(1);
  });
});
