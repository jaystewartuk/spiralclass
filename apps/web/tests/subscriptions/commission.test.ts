import { afterEach, describe, expect, it } from "vitest";
import {
  commissionRate,
  computeCommission,
  payableForNet,
  withinCommissionWindow,
  type CommissionInvoice,
  type CommissionTeacher,
} from "@/lib/subscriptions/commission";

const ACCOUNT_START = new Date("2026-01-01T00:00:00Z");

// The arithmetic is exercised at a rate this test picks, never at the
// deployment's. That is the point of the rate being an argument: no real
// commercial term has to exist in this repository for the maths to be pinned.
const RATE = 0.25;

const teachers: CommissionTeacher[] = [
  { id: "t1", name: "Referred One", referralSource: "alicia-moreno", createdAt: ACCOUNT_START },
  { id: "t2", name: "Referred Two", referralSource: "alicia-moreno", createdAt: ACCOUNT_START },
  { id: "t3", name: "Organic", referralSource: null, createdAt: ACCOUNT_START },
];

function inv(
  partial: Partial<CommissionInvoice> & { teacherId: string; invoiceId: string },
): CommissionInvoice {
  return {
    netMinorUnits: 19_000,
    status: "paid",
    paidAt: new Date("2026-02-01T00:00:00Z"),
    periodStart: new Date("2026-02-01T00:00:00Z"),
    ...partial,
  };
}

describe("commission math", () => {
  it("takes the configured share of net on each paid invoice in the first 12 months", () => {
    const result = computeCommission({
      teachers,
      rate: RATE,
      invoices: [
        inv({ teacherId: "t1", invoiceId: "i1", netMinorUnits: 20_000 }),
        inv({ teacherId: "t1", invoiceId: "i2", netMinorUnits: 20_000 }),
      ],
    });
    const mira = result.find((r) => r.ambassador === "alicia-moreno")!;
    expect(mira.referredTeacherCount).toBe(2);
    // 2 invoices × 5,000 (25% of 20,000) = 10,000 payable.
    expect(mira.totalNetMinorUnits).toBe(40_000);
    expect(mira.totalPayableMinorUnits).toBe(10_000);
    expect(mira.lineItems).toHaveLength(2);
  });

  it("excludes invoices outside the first 12 months", () => {
    const result = computeCommission({
      teachers,
      rate: RATE,
      invoices: [
        inv({ teacherId: "t1", invoiceId: "in", paidAt: new Date("2026-06-01T00:00:00Z") }),
        // 13 months after account start → outside the window.
        inv({
          teacherId: "t1",
          invoiceId: "out",
          paidAt: new Date("2027-02-01T00:00:00Z"),
          periodStart: new Date("2027-02-01T00:00:00Z"),
        }),
      ],
    });
    const mira = result.find((r) => r.ambassador === "alicia-moreno")!;
    expect(mira.lineItems.map((l) => l.invoiceId)).toEqual(["in"]);
  });

  it("clawback: refunded/voided invoices are excluded from the total", () => {
    const result = computeCommission({
      teachers,
      rate: RATE,
      invoices: [
        inv({ teacherId: "t1", invoiceId: "paid", status: "paid", netMinorUnits: 19_000 }),
        inv({ teacherId: "t1", invoiceId: "void", status: "void", netMinorUnits: 19_000 }),
        inv({ teacherId: "t1", invoiceId: "failed", status: "failed", netMinorUnits: 19_000 }),
      ],
    });
    const mira = result.find((r) => r.ambassador === "alicia-moreno")!;
    expect(mira.lineItems).toHaveLength(1);
    expect(mira.totalPayableMinorUnits).toBe(payableForNet(19_000, RATE));
  });

  it("organic (no referral) teachers produce no commission line items", () => {
    const result = computeCommission({
      teachers,
      rate: RATE,
      // Only the organic teacher (t3, referralSource null) has an invoice.
      invoices: [inv({ teacherId: "t3", invoiceId: "i1" })],
    });
    // alicia-moreno still lists (she referred t1/t2) but earns nothing — t3's
    // invoice is never attributed because t3 has no referralSource.
    const mira = result.find((r) => r.ambassador === "alicia-moreno")!;
    expect(mira.lineItems).toHaveLength(0);
    expect(mira.totalPayableMinorUnits).toBe(0);
  });

  it("an ambassador whose referral never upgrades earns nothing but still lists", () => {
    const result = computeCommission({ teachers, rate: RATE, invoices: [] });
    const mira = result.find((r) => r.ambassador === "alicia-moreno")!;
    expect(mira.referredTeacherCount).toBe(2);
    expect(mira.totalPayableMinorUnits).toBe(0);
  });
});

describe("window helpers", () => {
  it("withinCommissionWindow is inclusive of start, exclusive of +12mo", () => {
    expect(withinCommissionWindow(ACCOUNT_START, ACCOUNT_START)).toBe(true);
    expect(withinCommissionWindow(ACCOUNT_START, new Date("2026-12-31T23:59:59Z"))).toBe(true);
    expect(withinCommissionWindow(ACCOUNT_START, new Date("2027-01-01T00:00:00Z"))).toBe(false);
    expect(withinCommissionWindow(ACCOUNT_START, new Date("2025-12-31T00:00:00Z"))).toBe(false);
  });

  it("payableForNet rounds to the minor unit", () => {
    expect(payableForNet(19_001, 0.5)).toBe(9_501); // round(9500.5)
    expect(payableForNet(10_000, 0.5)).toBe(5_000);
    expect(payableForNet(10_000, RATE)).toBe(2_500);
  });
});

// The rate is deployment configuration and this repository is public, so an
// unconfigured deployment must produce a visibly-zero report rather than a
// plausible number somebody could make a manual transfer against.
describe("commissionRate", () => {
  const original = process.env.COMMISSION_RATE_PERCENT;
  afterEach(() => {
    if (original === undefined) delete process.env.COMMISSION_RATE_PERCENT;
    else process.env.COMMISSION_RATE_PERCENT = original;
  });

  it("is zero when unset, so nothing is computed against a guess", () => {
    delete process.env.COMMISSION_RATE_PERCENT;
    expect(commissionRate()).toBe(0);
    expect(payableForNet(10_000)).toBe(0);
  });

  it("reads a whole percent", () => {
    process.env.COMMISSION_RATE_PERCENT = "25";
    expect(commissionRate()).toBe(0.25);
  });

  it("refuses a blank, non-numeric or out-of-range value rather than guessing", () => {
    for (const bad of ["", "  ", "half", "0", "-10", "101", "NaN"]) {
      process.env.COMMISSION_RATE_PERCENT = bad;
      expect(commissionRate()).toBe(0);
    }
  });
});
